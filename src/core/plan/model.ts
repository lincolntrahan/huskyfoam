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
  | { kind: 'freePair'; r: Vec2; t: Vec2 }
  /**
   * Home's X at split k's height on each face: the corner of the default lead-in / lead-out
   * (straight up from home, then across to the split). Follows the split when it moves.
   * `corner: 'last'` levels with the far side of the split's kerf corner (reversed loops).
   */
  | { kind: 'level'; split: number; corner?: 'last' }
  /**
   * Straight above split k's kerf point (on each face) at the safe jog height: where a plunge
   * into an inner contour starts and ends. `corner: 'last'` as for 'level'.
   */
  | { kind: 'above'; split: number; corner?: 'last' };

export type Speed = 'cut' | 'jog';

interface StepBase {
  id: string;
  /** Folder the step is in (a PlanGroup id); none = top level. */
  group?: string;
}

export interface SegmentStep extends StepBase {
  kind: 'segment';
  seg: number;
  reversed: boolean;
}

export interface LineStep extends StepBase {
  kind: 'line';
  from: string;
  to: string;
  speed: Speed;
}

/**
 * Jog from wherever the wire is to a point. 'over' goes straight up to the safe height, across,
 * and down to the point (straight when the point is directly above or below); 'straight' is a
 * direct move.
 */
export interface JogStep extends StepBase {
  kind: 'jog';
  to: string;
  route: 'over' | 'straight';
}

export type PlanStep = SegmentStep | LineStep | JogStep;

/** A folder of steps in the sequence tree (one level). */
export interface PlanGroup {
  id: string;
  name: string;
  /** Contour pair a template folder cuts. */
  pair?: number;
  /** Template that made it. */
  template?: 'loop' | 'loop-reverse' | 'le-te';
}

export interface CutPlan {
  /** Shared points; consecutive lines reference the same id, so dragging moves both. */
  points: Record<string, PlanPoint>;
  steps: PlanStep[];
  template: 'loop' | 'loop-reverse' | 'le-te' | 'custom';
  /** Folders; a folder's steps are the consecutive steps carrying its id. */
  groups?: PlanGroup[];
}


export const HOME = 'home';
export const splitId = (k: number) => `s${k}`;

/** A plan with nothing sequenced yet (new jobs start like this). */
export const emptyPlan = (): CutPlan => ({ points: { [HOME]: { kind: 'home' } }, steps: [], template: 'custom', groups: [] });

/** A fresh id with the given prefix that isn't used by any point or step. */
export function newId(plan: CutPlan, prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of [...Object.keys(plan.points), ...plan.steps.map((s) => s.id), ...(plan.groups ?? []).map((g) => g.id)]) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

/**
 * How splits and segments are numbered across contours. Contour c owns splits
 * split0..split0+splits-1 and segments seg0..seg0+segs-1; segment j of a contour runs from its
 * split j to split j+1, and on a closed contour the last one runs back to its first split.
 */
export interface ContourTopo {
  closed: boolean;
  split0: number;
  splits: number;
  seg0: number;
  segs: number;
}

export interface Topology {
  contours: ContourTopo[];
  splits: number;
  segs: number;
}

/** A plain segment count means one closed loop. */
export type Topo = number | Topology;

export function makeTopology(contours: { closed: boolean; splits: number }[]): Topology {
  let split0 = 0;
  let seg0 = 0;
  const out = contours.map((c) => {
    const segs = c.closed ? c.splits : Math.max(0, c.splits - 1);
    const t = { closed: c.closed, split0, splits: c.splits, seg0, segs };
    split0 += c.splits;
    seg0 += segs;
    return t;
  });
  return { contours: out, splits: split0, segs: seg0 };
}

export const asTopology = (t: Topo): Topology => (typeof t === 'number' ? makeTopology([{ closed: true, splits: t }]) : t);

/** Contour index owning segment g / split k. */
export const contourOfSeg = (t: Topology, g: number) => t.contours.findIndex((c) => g >= c.seg0 && g < c.seg0 + c.segs);
export const contourOfSplit = (t: Topology, k: number) => t.contours.findIndex((c) => k >= c.split0 && k < c.split0 + c.splits);

/** Global splits at the forward start and end of segment g. */
export function segSplits(t: Topo, g: number): { start: number; end: number } {
  const topo = asTopology(t);
  const c = topo.contours[contourOfSeg(topo, g)];
  if (!c) return { start: g, end: g + 1 };
  const j = g - c.seg0;
  return { start: c.split0 + j, end: c.split0 + ((j + 1) % c.splits) };
}

/** Split where a segment step starts / ends. */
export function segStartSplit(s: SegmentStep, t: Topo): number {
  const e = segSplits(t, s.seg);
  return s.reversed ? e.end : e.start;
}
export function segEndSplit(s: SegmentStep, t: Topo): number {
  const e = segSplits(t, s.seg);
  return s.reversed ? e.start : e.end;
}

/** Point id a step starts / ends at, creating the split point entry if needed. */
export function stepStartRef(plan: CutPlan, step: PlanStep, t: Topo): string {
  if (step.kind === 'line') return step.from;
  if (step.kind === 'jog') return step.to; // starts wherever the wire is: never leaves a gap
  return ensureSplit(plan, segStartSplit(step, t));
}
export function stepEndRef(plan: CutPlan, step: PlanStep, t: Topo): string {
  if (step.kind === 'line' || step.kind === 'jog') return step.to;
  return ensureSplit(plan, segEndSplit(step, t));
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
  for (const s of plan.steps) {
    if (s.kind === 'line') used.add(s.from).add(s.to);
    else if (s.kind === 'jog') used.add(s.to);
  }
  const points = Object.fromEntries(Object.entries(plan.points).filter(([id]) => used.has(id)));
  return { ...plan, points };
}
