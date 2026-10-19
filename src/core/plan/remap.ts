import { asTopology, contourOfSeg, contourOfSplit, splitId, type CutPlan, type PlanPoint, type PlanStep, type Topo } from './model';

/**
 * Keep a cut plan valid when splits change (SPEC M2b PR 1). Every function returns the new
 * plan, or null when the plan can't be carried over (the caller then resets to Loop).
 * Split and segment numbers are global (across contours); `t` says how contours divide them.
 */

/** Rename split references via `mapSplit` (old index -> new index, or null = can't keep). */
function renameSplits(plan: CutPlan, mapSplit: (k: number) => number | null): CutPlan | null {
  const rename = new Map<string, string>();
  const points: Record<string, PlanPoint> = {};
  for (const [id, p] of Object.entries(plan.points)) {
    if (p.kind !== 'split') {
      points[id] = p;
      continue;
    }
    const k = mapSplit(p.split);
    if (k === null) {
      const used = plan.steps.some((s) => s.kind === 'line' && (s.from === id || s.to === id));
      if (used) return null;
      continue;
    }
    rename.set(id, splitId(k));
    points[splitId(k)] = { kind: 'split', split: k };
  }
  const steps = plan.steps.map((s): PlanStep =>
    s.kind === 'line' ? { ...s, from: rename.get(s.from) ?? s.from, to: rename.get(s.to) ?? s.to } : s,
  );
  return { ...plan, points, steps };
}

/**
 * A split was added inside segment k, splitting it in two. On one closed loop (`t` omitted)
 * the new split is k+1; in general it follows segment k's start split.
 */
export function remapInsert(plan: CutPlan, k: number, t?: Topo): CutPlan {
  const topo = asTopology(t ?? Math.max(k + 1, 1));
  const c = topo.contours[contourOfSeg(topo, k)];
  const newSplit = c ? c.split0 + (k - c.seg0) + 1 : k + 1;
  const steps: PlanStep[] = [];
  for (const s of plan.steps) {
    if (s.kind !== 'segment') steps.push(s);
    else if (s.seg < k) steps.push(s);
    else if (s.seg > k) steps.push({ ...s, seg: s.seg + 1 });
    else {
      const a: PlanStep = { ...s, id: `${s.id}a`, seg: k };
      const b: PlanStep = { ...s, id: `${s.id}b`, seg: k + 1 };
      steps.push(...(s.reversed ? [b, a] : [a, b]));
    }
  }
  return renameSplits({ ...plan, steps }, (j) => (j >= newSplit ? j + 1 : j))!;
}

/** Segments either side of split i: the one ending there and the one starting there. */
export function segmentsAtSplit(t: Topo, i: number): { before: number; after: number } | null {
  const topo = asTopology(t);
  const c = topo.contours[contourOfSplit(topo, i)];
  if (!c) return null;
  const j = i - c.split0;
  if (!c.closed && (j === 0 || j === c.splits - 1)) return null; // an open contour's ends
  return { before: c.seg0 + ((j - 1 + c.splits) % c.splits), after: c.seg0 + j };
}

/**
 * Split i was removed, merging the segments either side of it. Works only where those two are
 * cut back-to-back in the same direction; any other use of them (or a line attached to split
 * i) returns null. A plain number `t` means one closed loop of that many splits.
 */
export function remapRemove(plan: CutPlan, i: number, t: Topo): CutPlan | null {
  const at = segmentsAtSplit(t, i);
  if (!at) return null;
  const { before: prev, after: gone } = at;
  const newSeg = (j: number) => (j > gone ? j - 1 : j);
  const merged = newSeg(prev);
  const steps: PlanStep[] = [];
  for (let x = 0; x < plan.steps.length; x++) {
    const s = plan.steps[x];
    if (s.kind !== 'segment') {
      steps.push(s);
      continue;
    }
    if (s.seg !== prev && s.seg !== gone) {
      steps.push({ ...s, seg: newSeg(s.seg) });
      continue;
    }
    const next = plan.steps[x + 1];
    const first = s.reversed ? gone : prev;
    const second = s.reversed ? prev : gone;
    if (s.seg === first && next?.kind === 'segment' && next.seg === second && next.reversed === s.reversed) {
      steps.push({ ...s, seg: merged });
      x++; // consumed the pair
    } else return null;
  }
  return renameSplits({ ...plan, steps }, (j) => (j === i ? null : j > i ? j - 1 : j));
}

/**
 * The loop start of a closed contour moved to its split i (global): that contour's splits and
 * segments renumber by -i within it. A plain number `t` means one closed loop.
 */
export function remapRotate(plan: CutPlan, i: number, t: Topo): CutPlan {
  const topo = asTopology(t);
  const c = topo.contours[contourOfSplit(topo, i)];
  if (!c) return plan;
  const r = i - c.split0;
  const n = c.splits;
  const rotSeg = (g: number) => (g >= c.seg0 && g < c.seg0 + c.segs ? c.seg0 + ((g - c.seg0 - r + n) % n) : g);
  const rotSplit = (k: number) => (k >= c.split0 && k < c.split0 + n ? c.split0 + ((k - c.split0 - r + n) % n) : k);
  const steps = plan.steps.map((s): PlanStep => (s.kind === 'segment' ? { ...s, seg: rotSeg(s.seg) } : s));
  return renameSplits({ ...plan, steps }, rotSplit)!;
}

/**
 * How a split edit renumbered the segments (so per-segment settings can follow), in global
 * segment numbers:
 * - insert: segment k was split in two.
 * - remove: segment i merged into the one before it.
 * - rotate: a closed contour's segments base..base+n-1 renumbered by -i within it.
 */
export type SegmentChange =
  | { kind: 'insert'; k: number }
  | { kind: 'remove'; i: number; n: number }
  | { kind: 'rotate'; i: number; n: number; base?: number };

/**
 * Carry per-segment settings (e.g. kerf/speed overrides) across a split edit. An inserted split
 * gives both halves the old segment's settings; a removed one keeps the earlier segment's.
 */
export function remapSegmentMap<T>(map: Record<number, T>, change: SegmentChange): Record<number, T> {
  const out: Record<number, T> = {};
  for (const [key, v] of Object.entries(map)) {
    const j = Number(key);
    if (change.kind === 'insert') {
      if (j < change.k) out[j] = v;
      else if (j > change.k) out[j + 1] = v;
      else out[j] = out[j + 1] = v;
    } else if (change.kind === 'remove') {
      if (j === change.i) continue; // merged into the previous segment
      const nj = j > change.i ? j - 1 : j;
      out[nj] = v;
    } else {
      const base = change.base ?? 0;
      out[j >= base && j < base + change.n ? base + ((j - base - change.i + change.n) % change.n) : j] = v;
    }
  }
  return out;
}
