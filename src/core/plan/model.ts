import type { Vec2 } from '../geom/vec';

/**
 * Cut plan (SPEC §4.10): an ordered list of steps from home back to home. Steps are either a
 * matched profile segment (forward or reversed) or a straight line the user inserted.
 */
export type PlanPoint =
  | { kind: 'home' }
  /** Matched split k; resolves to that split's kerf point on each face. */
  | { kind: 'split'; split: number }
  /** Straight wire: same XY on both faces. */
  | { kind: 'free'; p: Vec2 }
  /** Unlocked: separate root and tip XY. */
  | { kind: 'freePair'; r: Vec2; t: Vec2 };

export type Speed = 'cut' | 'jog';

export interface SegmentStep {
  id: string;
  kind: 'segment';
  seg: number;
  reversed: boolean;
}

export interface LineStep {
  id: string;
  kind: 'line';
  from: string;
  to: string;
  speed: Speed;
}

export type PlanStep = SegmentStep | LineStep;

export interface CutPlan {
  /** Shared points; consecutive lines reference the same id, so dragging moves both. */
  points: Record<string, PlanPoint>;
  steps: PlanStep[];
  template: 'loop' | 'loop-reverse' | 'le-te' | 'custom';
}

export const HOME = 'home';
export const splitId = (k: number) => `s${k}`;

/** A fresh id with the given prefix that isn't used by any point or step. */
export function newId(plan: CutPlan, prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of [...Object.keys(plan.points), ...plan.steps.map((s) => s.id)]) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

/** Split where a segment step starts / ends (in loop order, n segments). */
export function segStartSplit(s: SegmentStep, n: number): number {
  return s.reversed ? (s.seg + 1) % n : s.seg;
}
export function segEndSplit(s: SegmentStep, n: number): number {
  return s.reversed ? s.seg : (s.seg + 1) % n;
}

/** Point id a step starts / ends at, creating the split point entry if needed. */
export function stepStartRef(plan: CutPlan, step: PlanStep, n: number): string {
  if (step.kind === 'line') return step.from;
  return ensureSplit(plan, segStartSplit(step, n));
}
export function stepEndRef(plan: CutPlan, step: PlanStep, n: number): string {
  if (step.kind === 'line') return step.to;
  return ensureSplit(plan, segEndSplit(step, n));
}

/** Mutates plan.points to make sure split k has an entry; returns its id. */
export function ensureSplit(plan: CutPlan, k: number): string {
  const id = splitId(k);
  if (!plan.points[id]) plan.points[id] = { kind: 'split', split: k };
  return id;
}

export function clonePlan(plan: CutPlan): CutPlan {
  return structuredClone(plan);
}

/** Drop points no step references (home is always kept). */
export function prunePoints(plan: CutPlan): CutPlan {
  const used = new Set<string>([HOME]);
  for (const s of plan.steps) if (s.kind === 'line') used.add(s.from).add(s.to);
  const points = Object.fromEntries(Object.entries(plan.points).filter(([id]) => used.has(id)));
  return { ...plan, points };
}
