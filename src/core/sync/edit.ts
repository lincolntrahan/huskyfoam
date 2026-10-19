import { spanS, withinS, wrapS, type ArcLoop } from '../geom/arc';
import type { CutPlan } from '../plan/model';
import { remapInsert, remapRemove, remapRotate, type SegmentChange } from '../plan/remap';
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
}

const other = (s: Side): Side => (s === 'root' ? 'tip' : 'root');

/** Add a split at arc position s on one side; the partner goes at the same fraction on the other. */
export function addSplit(sync: SyncSettings, plan: CutPlan | null, arcs: Arcs, side: Side, s: number): SyncEdit | null {
  const at = locate(arcs[side], sync[side], s);
  if (!at) return null; // on top of an existing split
  const partner = atFraction(arcs[other(side)], sync[other(side)], at.k, at.f);
  const next = { ...sync, root: sync.root.slice(), tip: sync.tip.slice() };
  next[side].splice(at.k + 1, 0, wrapS(arcs[side], s));
  next[other(side)].splice(at.k + 1, 0, partner);
  if (sync.linked) next.linked = [...sync.linked.slice(0, at.k + 1), false, ...sync.linked.slice(at.k + 1)];
  return { sync: next, plan: plan && remapInsert(plan, at.k), change: { kind: 'insert', k: at.k } };
}

/**
 * Slide split i along its own profile; it can't pass its neighbours. A linked split drags its
 * partner along, keeping the same fraction of the stretch between the neighbouring splits.
 */
export function moveSplit(sync: SyncSettings, plan: CutPlan | null, arcs: Arcs, side: Side, i: number, s: number): SyncEdit | null {
  const list = sync[side];
  const n = list.length;
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

/** Remove split pair i, merging its two segments. */
export function removeSplit(sync: SyncSettings, plan: CutPlan | null, i: number): SyncEdit | null {
  const n = sync.root.length;
  if (n < 2) return null;
  const next = { ...sync, root: sync.root.filter((_, j) => j !== i), tip: sync.tip.filter((_, j) => j !== i) };
  if (sync.linked) next.linked = sync.linked.filter((_, j) => j !== i);
  const change: SegmentChange = { kind: 'remove', i, n };
  if (!plan) return { sync: next, plan, change };
  const remapped = remapRemove(plan, i, n);
  if (remapped) return { sync: next, plan: remapped, change };
  return {
    change,
    sync: next,
    plan: loopPlan(n - 1),
    note: `Removing split ${i + 1} broke the custom cut plan (it used that split or one of its segments on its own), so the plan was reset to Loop.`,
  };
}

/** Make split i the loop start (segment 1). */
export function setLoopStart(sync: SyncSettings, plan: CutPlan | null, i: number): SyncEdit {
  const rot = <T,>(l: T[]) => [...l.slice(i), ...l.slice(0, i)];
  const n = sync.root.length;
  const next: SyncSettings = { ...sync, root: rot(sync.root), tip: rot(sync.tip) };
  if (sync.linked) next.linked = rot(sync.linked);
  return { sync: next, plan: plan && remapRotate(plan, i, n), change: { kind: 'rotate', i, n } };
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
