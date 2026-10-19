import type { Vec2 } from '../geom/vec';
import {
  HOME,
  clonePlan,
  ensureSplit,
  newId,
  prunePoints,
  segEndSplit,
  stepEndRef,
  stepStartRef,
  type CutPlan,
  type PlanPoint,
  type PlanStep,
  type Speed,
} from './model';

// All edits return a new plan and mark it custom.
const custom = (p: CutPlan): CutPlan => prunePoints({ ...p, template: 'custom' });

export function moveStep(plan: CutPlan, i: number, delta: -1 | 1): CutPlan {
  const j = i + delta;
  if (j < 0 || j >= plan.steps.length) return plan;
  const p = clonePlan(plan);
  [p.steps[i], p.steps[j]] = [p.steps[j], p.steps[i]];
  return custom(p);
}

export function removeStep(plan: CutPlan, i: number): CutPlan {
  const p = clonePlan(plan);
  p.steps.splice(i, 1);
  return custom(p);
}

/** Reverse a segment, or swap the ends of a line. */
export function reverseStep(plan: CutPlan, i: number): CutPlan {
  const p = clonePlan(plan);
  const s = p.steps[i];
  if (s.kind === 'segment') s.reversed = !s.reversed;
  else [s.from, s.to] = [s.to, s.from];
  return custom(p);
}

export function setSpeed(plan: CutPlan, i: number, speed: Speed): CutPlan {
  const p = clonePlan(plan);
  const s = p.steps[i];
  if (s.kind === 'line') s.speed = speed;
  return custom(p);
}

export function addSegment(plan: CutPlan, at: number, seg: number, reversed: boolean): CutPlan {
  const p = clonePlan(plan);
  p.steps.splice(at, 0, { id: newId(p, 'g'), kind: 'segment', seg, reversed });
  return custom(p);
}

/** Close the gap before step `before` with a straight line (before = steps.length closes back to home). */
export function bridgeGap(plan: CutPlan, before: number, speed: Speed, n: number): CutPlan {
  const p = clonePlan(plan);
  const from = before > 0 ? stepEndRef(p, p.steps[before - 1], n) : HOME;
  const to = before < p.steps.length ? stepStartRef(p, p.steps[before], n) : HOME;
  p.steps.splice(before, 0, { id: newId(p, 'l'), kind: 'line', from, to, speed });
  return custom(p);
}

/** Split line step i in two at a new free point. */
export function insertPointOnLine(plan: CutPlan, i: number, at: Vec2): CutPlan {
  const p = clonePlan(plan);
  const s = p.steps[i];
  if (s.kind !== 'line') return plan;
  const pid = newId(p, 'p');
  p.points[pid] = { kind: 'free', p: at };
  const second: PlanStep = { id: newId(p, 'l'), kind: 'line', from: pid, to: s.to, speed: s.speed };
  s.to = pid;
  p.steps.splice(i + 1, 0, second);
  return custom(p);
}

export function setPoint(plan: CutPlan, id: string, pt: PlanPoint): CutPlan {
  const p = clonePlan(plan);
  p.points[id] = pt;
  return custom(p);
}

/** Index right after the first step that ends at split k, or -1. */
export function indexAfterSplit(plan: CutPlan, k: number, n: number): number {
  const i = plan.steps.findIndex((s) => s.kind === 'segment' && segEndSplit(s, n) === k);
  return i < 0 ? -1 : i + 1;
}

/**
 * Insert a chain of lines that leaves split k through the given free points. If `endSplit`
 * is given the chain runs back in to that split; otherwise it ends at the last free point
 * (the step list will then show a gap until the plan continues from there).
 * The first and last lines are cut speed (run-out / run-in), the ones between are jogs.
 */
export function insertRunOut(plan: CutPlan, k: number, through: PlanPoint[], endSplit: number | null, n: number): CutPlan {
  const p = clonePlan(plan);
  let at = indexAfterSplit(p, k, n);
  if (at < 0) at = p.steps.length;
  const ids = [ensureSplit(p, k)];
  for (const pt of through) {
    const id = newId(p, 'p');
    p.points[id] = pt;
    ids.push(id);
  }
  if (endSplit !== null) ids.push(ensureSplit(p, endSplit));
  const lines: PlanStep[] = [];
  for (let j = 1; j < ids.length; j++) {
    const first = j === 1;
    const last = j === ids.length - 1 && endSplit !== null;
    lines.push({ id: '', kind: 'line', from: ids[j - 1], to: ids[j], speed: first || last ? 'cut' : 'jog' });
  }
  for (const l of lines) {
    l.id = newId(p, 'l');
    p.steps.splice(at++, 0, l);
  }
  return custom(p);
}

/** Out-and-back at split k: run out to an unlocked point and straight back (both cut). */
export function insertOutAndBack(plan: CutPlan, k: number, out: { r: Vec2; t: Vec2 }, n: number): CutPlan {
  return insertRunOut(plan, k, [{ kind: 'freePair', r: out.r, t: out.t }], k, n);
}
