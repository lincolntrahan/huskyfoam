import { splitId, type CutPlan, type PlanPoint, type PlanStep } from './model';

/**
 * Keep a cut plan valid when splits change (SPEC M2b PR 1). Every function returns the new
 * plan, or null when the plan can't be carried over (the caller then resets to Loop).
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

/** A split was inserted at index k+1 (splitting segment k in two). */
export function remapInsert(plan: CutPlan, k: number): CutPlan {
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
  return renameSplits({ ...plan, steps }, (j) => (j > k ? j + 1 : j))!;
}

/**
 * Split i (of n) was removed, merging segments i-1 and i. Works only where those two are cut
 * back-to-back in the same direction; any other use of them (or a line attached to split i)
 * returns null.
 */
export function remapRemove(plan: CutPlan, i: number, n: number): CutPlan | null {
  const prev = (i - 1 + n) % n;
  const newIdx = (j: number) => (j > i ? j - 1 : j);
  const merged = newIdx(prev);
  const steps: PlanStep[] = [];
  for (let x = 0; x < plan.steps.length; x++) {
    const s = plan.steps[x];
    if (s.kind !== 'segment') {
      steps.push(s);
      continue;
    }
    if (s.seg !== prev && s.seg !== i) {
      steps.push({ ...s, seg: newIdx(s.seg) });
      continue;
    }
    const next = plan.steps[x + 1];
    const first = s.reversed ? i : prev;
    const second = s.reversed ? prev : i;
    if (s.seg === first && next?.kind === 'segment' && next.seg === second && next.reversed === s.reversed) {
      steps.push({ ...s, seg: merged });
      x++; // consumed the pair
    } else return null;
  }
  return renameSplits({ ...plan, steps }, (j) => (j === i ? null : newIdx(j)));
}

/** The loop start moved to old split i: everything renumbers by -i (mod n). */
export function remapRotate(plan: CutPlan, i: number, n: number): CutPlan {
  const rot = (j: number) => (j - i + n) % n;
  const steps = plan.steps.map((s): PlanStep => (s.kind === 'segment' ? { ...s, seg: rot(s.seg) } : s));
  return renameSplits({ ...plan, steps }, rot)!;
}

/** How a split edit renumbered the segments (so per-segment settings can follow). */
export type SegmentChange =
  | { kind: 'insert'; k: number }
  | { kind: 'remove'; i: number; n: number }
  | { kind: 'rotate'; i: number; n: number };

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
    } else out[(j - change.i + change.n) % change.n] = v;
  }
  return out;
}
