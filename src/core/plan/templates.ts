import type { Vec2 } from '../geom/vec';
import { asTopology, HOME, splitId, type CutPlan, type PlanStep, type Topo } from './model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the default plan leaves the outer contour to cut another one: both are global split numbers. */
export interface ContourEntry {
  /** Split on the outer contour (contour 0) the cut leaves from and comes back to. */
  outer: number;
  /** Contour cut there. */
  contour: number;
}

/**
 * Home -> loop start -> every segment -> back to the start -> home. Forward is the same as M1;
 * reversed runs the loop the other way (all segments reversed, last first).
 * With more contours, each `entries` contour is cut when the outer loop reaches its entry
 * split: a cut line in to its first split, all the way round it (an open contour: to its end
 * and back), and a cut line back out to the outer contour.
 */
export function loopPlan(t: Topo, reversed = false, entries: ContourEntry[] = []): CutPlan {
  const topo = asTopology(t);
  const outer = topo.contours[0] ?? { closed: true, split0: 0, splits: 0, seg0: 0, segs: 0 };
  const points: CutPlan['points'] = { [HOME]: { kind: 'home' }, [splitId(0)]: { kind: 'split', split: 0 } };
  const steps: PlanStep[] = [];
  let g = 0;
  let l = 0;
  const seg = (k: number, rev: boolean) => steps.push({ id: `g${++g}`, kind: 'segment', seg: k, reversed: rev });
  const line = (from: number | 'home', to: number | 'home') => {
    const id = (k: number | 'home') => {
      if (k === 'home') return HOME;
      points[splitId(k)] = { kind: 'split', split: k };
      return splitId(k);
    };
    steps.push({ id: `l${++l}`, kind: 'line', from: id(from), to: id(to), speed: 'cut' });
  };
  /** Cut every contour entered at outer split k, then return to k. */
  const visit = (k: number) => {
    for (const e of entries.filter((x) => x.outer === k)) {
      const c = topo.contours[e.contour];
      if (!c || !c.segs) continue;
      line(k, c.split0);
      const ks = Array.from({ length: c.segs }, (_, j) => c.seg0 + j);
      if (c.closed) for (const j of reversed ? ks.reverse() : ks) seg(j, reversed);
      else {
        for (const j of ks) seg(j, false);
        for (const j of ks.reverse()) seg(j, true);
      }
      line(c.split0, k);
    }
  };

  // an open outer contour runs end to end: reversed, it starts at its last split
  const first = !outer.closed && reversed ? outer.split0 + outer.splits - 1 : outer.split0;
  const last = outer.closed ? outer.split0 : reversed ? outer.split0 : outer.split0 + outer.splits - 1;
  line('home', first);
  const outerSegs = Array.from({ length: outer.segs }, (_, j) => outer.seg0 + j);
  // contours are visited from the outer split the wire is at (each split once)
  visit(first);
  if (!reversed) {
    for (const j of outerSegs) {
      if (j > 0) visit(j);
      seg(j, false);
    }
    if (last !== first) visit(last);
  } else {
    for (const j of outerSegs.reverse()) {
      seg(j, true);
      if (j !== first) visit(j);
    }
  }
  line(last, 'home');
  return { points, steps, template: reversed ? 'loop-reverse' : 'loop' };
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
