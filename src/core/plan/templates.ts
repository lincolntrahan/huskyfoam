import type { Vec2 } from '../geom/vec';
import { HOME, splitId, type CutPlan, type PlanStep } from './model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Home -> loop start -> every segment -> back to the start -> home. Forward is the same as M1;
 * reversed runs the loop the other way (all segments reversed, last first).
 */
export function loopPlan(n: number, reversed = false): CutPlan {
  const segs = Array.from({ length: n }, (_, k): PlanStep => ({ id: `g${k + 1}`, kind: 'segment', seg: k, reversed }));
  const steps: PlanStep[] = [
    { id: 'l1', kind: 'line', from: HOME, to: splitId(0), speed: 'cut' },
    ...(reversed ? segs.reverse() : segs),
    { id: 'l2', kind: 'line', from: splitId(0), to: HOME, speed: 'cut' },
  ];
  return { points: { [HOME]: { kind: 'home' }, [splitId(0)]: { kind: 'split', split: 0 } }, steps, template: reversed ? 'loop-reverse' : 'loop' };
}

export interface LeTeInput {
  /** Root split points in loop order (index = split number), already positioned. */
  splits: Vec2[];
  /** Foam block on the faces; used to place run-in/out and jog points. */
  block: Rect;
  /** Distance kept from the block for free points. */
  clearance: number;
}

const XTOL = 1e-3;

/**
 * LE and TE guessed from min/max X of the root splits. With tabs there may be two splits at
 * each end (bottom and top corner of the tab end); the lower one starts the lower surface,
 * the upper one the upper surface.
 */
export function guessLeTe(splits: Vec2[]) {
  const xs = splits.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const pick = (x: number, lowest: boolean) => {
    let best = -1;
    splits.forEach((p, k) => {
      if (Math.abs(p.x - x) > XTOL) return;
      if (best < 0 || (lowest ? p.y < splits[best].y : p.y > splits[best].y)) best = k;
    });
    return best;
  };
  return { leLow: pick(minX, true), leUp: pick(minX, false), teLow: pick(maxX, true), teUp: pick(maxX, false) };
}

/**
 * Upper surface LE->TE, run out aft, jog over the block, run in at the LE, lower surface LE->TE,
 * run out, jog home over the block. On a CCW loop the lower surface is forward from the LE and
 * the upper surface is the reverse.
 */
export function leTePlan(input: LeTeInput, ends = guessLeTe(input.splits)): CutPlan {
  const n = input.splits.length;
  const { leLow, leUp, teLow, teUp } = ends;
  const { block: b, clearance: c } = input;
  const S = input.splits;
  const front = b.x - c;
  const aft = b.x + b.w + c;
  const above = b.y + b.h + c;

  const points: CutPlan['points'] = {
    [HOME]: { kind: 'home' },
    [splitId(leLow)]: { kind: 'split', split: leLow },
    [splitId(leUp)]: { kind: 'split', split: leUp },
    [splitId(teLow)]: { kind: 'split', split: teLow },
    [splitId(teUp)]: { kind: 'split', split: teUp },
    p1: { kind: 'free', p: { x: front, y: S[leUp].y } }, // run-in, upper
    p2: { kind: 'free', p: { x: aft, y: S[teUp].y } }, // run-out, upper
    p3: { kind: 'free', p: { x: aft, y: above } },
    p4: { kind: 'free', p: { x: front, y: above } },
    p5: { kind: 'free', p: { x: front, y: S[leLow].y } }, // run-in, lower
    p6: { kind: 'free', p: { x: aft, y: S[teLow].y } }, // run-out, lower
    p7: { kind: 'free', p: { x: aft, y: above } },
    p8: { kind: 'free', p: { x: front, y: above } },
  };

  let id = 0;
  const line = (from: string, to: string, speed: 'cut' | 'jog'): PlanStep => ({ id: `l${++id}`, kind: 'line', from, to, speed });
  const segs = (from: number, to: number, reversed: boolean): PlanStep[] => {
    const out: PlanStep[] = [];
    if (!reversed) for (let k = from; k !== to; k = (k + 1) % n) out.push({ id: `g${++id}`, kind: 'segment', seg: k, reversed });
    else for (let k = from; k !== to; k = (k - 1 + n) % n) out.push({ id: `g${++id}`, kind: 'segment', seg: (k - 1 + n) % n, reversed });
    return out;
  };

  const steps: PlanStep[] = [
    line(HOME, 'p1', 'jog'),
    line('p1', splitId(leUp), 'cut'),
    ...segs(leUp, teUp, true),
    line(splitId(teUp), 'p2', 'cut'),
    line('p2', 'p3', 'jog'),
    line('p3', 'p4', 'jog'),
    line('p4', 'p5', 'jog'),
    line('p5', splitId(leLow), 'cut'),
    ...segs(leLow, teLow, false),
    line(splitId(teLow), 'p6', 'cut'),
    line('p6', 'p7', 'jog'),
    line('p7', 'p8', 'jog'),
    line('p8', HOME, 'jog'),
  ];
  return { points, steps, template: 'le-te' };
}
