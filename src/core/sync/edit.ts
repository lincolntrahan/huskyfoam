import { withinS, wrapS, type ArcLoop } from '../geom/arc';
import type { CutPlan } from '../plan/model';
import { remapInsert, remapRemove, remapRotate } from '../plan/remap';
import { loopPlan } from '../plan/templates';
import { atFraction, locate, type SyncSettings } from './sync';

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
  return { sync: next, plan: plan && remapInsert(plan, at.k) };
}

/** Slide split i along its own profile; it can't pass its neighbours. */
export function moveSplit(sync: SyncSettings, plan: CutPlan | null, arcs: Arcs, side: Side, i: number, s: number): SyncEdit | null {
  const list = sync[side];
  const n = list.length;
  if (n > 1) {
    const prev = list[(i - 1 + n) % n];
    const next = list[(i + 1) % n];
    if (!withinS(arcs[side], prev, next, s)) return null; // with 2 splits prev === next: anywhere but on it
  }
  const out = { ...sync, [side]: list.map((v, j) => (j === i ? wrapS(arcs[side], s) : v)) } as SyncSettings;
  return { sync: out, plan };
}

/** Remove split pair i, merging its two segments. */
export function removeSplit(sync: SyncSettings, plan: CutPlan | null, i: number): SyncEdit | null {
  const n = sync.root.length;
  if (n < 2) return null;
  const next = { ...sync, root: sync.root.filter((_, j) => j !== i), tip: sync.tip.filter((_, j) => j !== i) };
  if (!plan) return { sync: next, plan };
  const remapped = remapRemove(plan, i, n);
  if (remapped) return { sync: next, plan: remapped };
  return {
    sync: next,
    plan: loopPlan(n - 1),
    note: `Removing split ${i + 1} broke the custom cut plan (it used that split or one of its segments on its own), so the plan was reset to Loop.`,
  };
}

/** Make split i the loop start (segment 1). */
export function setLoopStart(sync: SyncSettings, plan: CutPlan | null, i: number): SyncEdit {
  const rot = (l: number[]) => [...l.slice(i), ...l.slice(0, i)];
  return { sync: { ...sync, root: rot(sync.root), tip: rot(sync.tip) }, plan: plan && remapRotate(plan, i, sync.root.length) };
}

/** Add a pin at s on one side, paired at the same fraction of the segment on the other side. */
export function addPin(sync: SyncSettings, arcs: Arcs, side: Side, s: number): SyncSettings | null {
  const at = locate(arcs[side], sync[side], s);
  if (!at) return null;
  const partner = atFraction(arcs[other(side)], sync[other(side)], at.k, at.f);
  const pin = side === 'root' ? { root: wrapS(arcs.root, s), tip: partner } : { root: partner, tip: wrapS(arcs.tip, s) };
  return { ...sync, pins: [...sync.pins, pin] };
}

export function movePin(sync: SyncSettings, arcs: Arcs, i: number, side: Side, s: number): SyncSettings {
  return { ...sync, pins: sync.pins.map((p, j) => (j === i ? { ...p, [side]: wrapS(arcs[side], s) } : p)) };
}

export function removePin(sync: SyncSettings, i: number): SyncSettings {
  return { ...sync, pins: sync.pins.filter((_, j) => j !== i) };
}

