import { arcClosed, spanS, withinS, wrapS, type ArcLoop } from '../geom/arc';
import { asTopology, type CutPlan, type Topology } from '../plan/model';
import { remapInsert, remapRemove, remapRotate, segmentsAtSplit, type SegmentChange } from '../plan/remap';
import { loopPlan } from '../plan/templates';
import { atFraction, locate, type Pin, type SyncSettings } from './sync';

export type Side = 'root' | 'tip';

export interface Arcs {
  root: ArcLoop;
  tip: ArcLoop;
}

/** Result of a sync edit: the new sync, the plan carried over, and a note if the plan was reset. */
export interface SyncEdit {
  sync: SyncSettings;
  plan: CutPlan | null;
  note?: string;
  /** Segment renumbering, if any (apply it to per-segment overrides). */
  change?: SegmentChange;
  /** Contour pair the sync belongs to (0 = the outer contour, the default). */
  pair?: number;
}

const other = (s: Side): Side => (s === 'root' ? 'tip' : 'root');

/**
 * Which contour pair a sync belongs to, so plan remaps use global split / segment numbers.
 * Omitted: the sync is the only contour, a closed loop.
 */
export interface PairCtx {
  topo: Topology;
  pair: number;
}

const ctxOf = (sync: SyncSettings, ctx?: PairCtx) => {
  const topo = ctx?.topo ?? asTopology(sync.root.length);
  const c = topo.contours[ctx?.pair ?? 0];
  return { topo, split0: c?.split0 ?? 0, seg0: c?.seg0 ?? 0 };
};

/** An open contour's end splits are fixed. */
const isEnd = (arcs: Arcs, n: number, i: number) => !arcClosed(arcs.root) && (i === 0 || i === n - 1);

/** Add a split at arc position s on one side; the partner goes at the same fraction on the other. */
export function addSplit(sync: SyncSettings, plan: CutPlan | null, arcs: Arcs, side: Side, s: number, ctx?: PairCtx): SyncEdit | null {
  const at = locate(arcs[side], sync[side], s);
  if (!at) return null; // on top of an existing split
  const partner = atFraction(arcs[other(side)], sync[other(side)], at.k, at.f);
  const next = { ...sync, root: sync.root.slice(), tip: sync.tip.slice() };
  next[side].splice(at.k + 1, 0, wrapS(arcs[side], s));
  next[other(side)].splice(at.k + 1, 0, partner);
  if (sync.linked) next.linked = [...sync.linked.slice(0, at.k + 1), false, ...sync.linked.slice(at.k + 1)];
  const { topo, seg0 } = ctxOf(sync, ctx);
  const g = seg0 + at.k;
  return { sync: next, plan: plan && remapInsert(plan, g, topo), change: { kind: 'insert', k: g } };
}

/**
 * Slide split i along its own profile; it can't pass its neighbours. A linked split drags its
 * partner along, keeping the same fraction of the stretch between the neighbouring splits.
 */
export function moveSplit(sync: SyncSettings, plan: CutPlan | null, arcs: Arcs, side: Side, i: number, s: number): SyncEdit | null {
  const list = sync[side];
  const n = list.length;
  if (isEnd(arcs, n, i)) return null;
  // with one split the stretch is the whole loop from where it was; with 2 splits prev === next
  const prev = n > 1 ? list[(i - 1 + n) % n] : list[i];
  const next = n > 1 ? list[(i + 1) % n] : list[i];
  if (n > 1 && !withinS(arcs[side], prev, next, s)) return null;
  const out = { ...sync, [side]: list.map((v, j) => (j === i ? wrapS(arcs[side], s) : v)) } as SyncSettings;
  if (sync.linked?.[i]) {
    const o = other(side);
    const ol = sync[o];
    const oPrev = n > 1 ? ol[(i - 1 + n) % n] : ol[i];
    const oNext = n > 1 ? ol[(i + 1) % n] : ol[i];
    const f = wrapS(arcs[side], s - prev) / spanS(arcs[side], prev, next);
    out[o] = ol.map((v, j) => (j === i ? wrapS(arcs[o], oPrev + f * spanS(arcs[o], oPrev, oNext)) : v));
  }
  return { sync: out, plan };
}

/**
 * Link or unlink split i. Linking snaps the other profile's split to the same fraction of its
 * stretch (between the neighbouring splits) as the one on `side`.
 */
export function setSplitLinked(sync: SyncSettings, arcs: Arcs, side: Side, i: number, on: boolean): SyncSettings {
  const linked = sync.root.map((_, j) => (j === i ? on : (sync.linked?.[j] ?? false)));
  const base = { ...sync, linked };
  if (!on) return base;
  return moveSplit(base, null, arcs, side, i, sync[side][i])?.sync ?? base;
}

/** Remove split pair i, merging its two segments (an open contour's end splits stay). */
export function removeSplit(sync: SyncSettings, plan: CutPlan | null, i: number, ctx?: PairCtx, arcs?: Arcs): SyncEdit | null {
  const n = sync.root.length;
  if (n < 2 || (arcs && isEnd(arcs, n, i))) return null;
  const { topo, split0 } = ctxOf(sync, ctx);
  const at = segmentsAtSplit(topo, split0 + i);
  if (!at) return null;
  const next = { ...sync, root: sync.root.filter((_, j) => j !== i), tip: sync.tip.filter((_, j) => j !== i) };
  if (sync.linked) next.linked = sync.linked.filter((_, j) => j !== i);
  const change: SegmentChange = { kind: 'remove', i: at.after, n };
  if (!plan) return { sync: next, plan, change };
  const remapped = remapRemove(plan, split0 + i, topo);
  if (remapped) return { sync: next, plan: remapped, change };
  return {
    change,
    sync: next,
    // with several contours the default plan rebuilds itself from the new splits
    plan: ctx ? null : loopPlan(n - 1),
    note: `Removing split ${split0 + i + 1} broke the custom cut plan (it used that split or one of its segments on its own), so the plan was reset to the default.`,
  };
}

/** Make split i the loop start (segment 1) of a closed contour. */
export function setLoopStart(sync: SyncSettings, plan: CutPlan | null, i: number, ctx?: PairCtx): SyncEdit {
  const rot = <T,>(l: T[]) => [...l.slice(i), ...l.slice(0, i)];
  const n = sync.root.length;
  const { topo, split0, seg0 } = ctxOf(sync, ctx);
  const next: SyncSettings = { ...sync, root: rot(sync.root), tip: rot(sync.tip) };
  if (sync.linked) next.linked = rot(sync.linked);
  return { sync: next, plan: plan && remapRotate(plan, split0 + i, topo), change: { kind: 'rotate', i, n, base: seg0 } };
}

/** Add a pin at s on one side, paired at the same fraction of the segment on the other side. */
export function addPin(sync: SyncSettings, arcs: Arcs, side: Side, s: number): SyncSettings | null {
  const at = locate(arcs[side], sync[side], s);
  if (!at) return null;
  const partner = atFraction(arcs[other(side)], sync[other(side)], at.k, at.f);
  const pin = side === 'root' ? { root: wrapS(arcs.root, s), tip: partner } : { root: partner, tip: wrapS(arcs.tip, s) };
  return { ...sync, pins: [...sync.pins, pin] };
}

/** Slide one end of pin i. A linked pin moves its other end to the same fraction of its segment. */
export function movePin(sync: SyncSettings, arcs: Arcs, i: number, side: Side, s: number): SyncSettings {
  return { ...sync, pins: sync.pins.map((p, j) => (j === i ? placePin(sync, arcs, p, side, s) : p)) };
}

function placePin(sync: SyncSettings, arcs: Arcs, p: Pin, side: Side, s: number): Pin {
  const out = { ...p, [side]: wrapS(arcs[side], s) };
  if (!p.linked) return out;
  const at = locate(arcs[side], sync[side], s);
  if (at) out[other(side)] = atFraction(arcs[other(side)], sync[other(side)], at.k, at.f);
  return out;
}

/** Link or unlink pin i; linking snaps the other end to match the end on `side`. */
export function setPinLinked(sync: SyncSettings, arcs: Arcs, i: number, side: Side, on: boolean): SyncSettings {
  return {
    ...sync,
    pins: sync.pins.map((p, j) => (j !== i ? p : on ? placePin(sync, arcs, { ...p, linked: true }, side, p[side]) : { ...p, linked: false })),
  };
}

export function removePin(sync: SyncSettings, i: number): SyncSettings {
  return { ...sync, pins: sync.pins.filter((_, j) => j !== i) };
}
