import type { Profile } from '../geom/profile';
import type { Vec2 } from '../geom/vec';
import type { JobSettings, MachinePreset } from '../types';
import { generateCut, projector } from './pipeline';

export type AlignH = 'center' | 'left' | 'right';
export type AlignV = 'middle' | 'bottom' | 'top';

/**
 * How the part sits on the machine (SPEC M2d). The user arranges the profiles relative to
 * each other (transforms, profile distance); everything else follows from these:
 * - along the wire, the left profile is `profileFromLeft` from the left carriage;
 * - vertically, the lowest profile point is `floor` above Y = 0;
 * - in X, the part is pushed toward the origin until a carriage would go past the travel limit;
 * - the block is placed around the profiles by the three alignments.
 */
export interface Layout {
  /** Left carriage plane to the left-hand profile plane (along the wire). */
  profileFromLeft: number;
  /** Height of the lowest profile point above the floor (Y = 0). */
  floor: number;
  /** Foam block size: w along the chord (X), h vertical (Y), len along the wire. 0 = not set. */
  block: { w: number; h: number; len: number };
  /** Profiles in the block along the wire: centred, or flush with the left / right face. */
  alongWire: AlignH;
  /** Profiles in the block along the chord (X): centred, or flush with the -X / +X side. */
  alongChord: AlignH;
  /** Profiles in the block vertically: centred, or on the bottom / top face. */
  vertical: AlignV;
}

export const defaultLayout = (machine: MachinePreset, distance: number): Layout => ({
  profileFromLeft: (machine.carriageSpacing - distance) / 2,
  floor: machine.units === 'mm' ? 10 : 0.5,
  block: { w: 0, h: 0, len: 0 },
  alongWire: 'center',
  alongChord: 'center',
  vertical: 'middle',
});

/** Where the block's ends and the profile planes are along the wire (from the left carriage). */
export function wireLayout(job: JobSettings, layout: Layout) {
  const distance = job.profile.distance ?? job.span;
  const zL = layout.profileFromLeft;
  const zR = zL + distance;
  const len = layout.block.len > 0 ? layout.block.len : distance;
  const left = layout.alongWire === 'left' ? zL : layout.alongWire === 'right' ? zR - len : (zL + zR) / 2 - len / 2;
  // inset of the root profile from the block's root face
  const inset = job.rootSide === 'left' ? zL - left : left + len - zR;
  return { distance, span: len, rootFaceFromLeft: left, inset };
}

function bounds(pts: Vec2[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Resolve a job's layout into the positions the cut uses: profile planes, the part offset and
 * the block rectangle. Jobs without a layout (older projects) are returned unchanged.
 * `hold`: keep this part offset instead of fitting it (while the user drags a profile).
 */
export function placeJob(job: JobSettings, root: Profile[], tip: Profile[], machine: MachinePreset, hold?: Vec2 | null): JobSettings {
  const layout = job.layout;
  if (!layout) return job;
  const w = wireLayout(job, layout);
  const base: JobSettings = {
    ...job,
    span: w.span,
    rootFaceFromLeft: w.rootFaceFromLeft,
    profile: { distance: w.distance, inset: w.inset },
    offset: { x: 0, y: 0 },
    block: { x: 0, y: 0, w: 0, h: 0 },
  };
  if (!root.length || !tip.length) return base;

  // Lay the part out at no offset, then shift it (the cut is translation-invariant).
  const first = generateCut(root, tip, base, machine);
  const outlines = first.pairs.length ? first.pairs.flatMap((p) => [...p.pts.root, ...p.pts.tip]) : [...first.profilePts.root, ...first.profilePts.tip];
  if (!outlines.length) return base;
  const b0 = bounds(outlines);

  let offset = hold ?? null;
  if (!offset) {
    // the closest any carriage comes to -X along the kerfed cut, before shifting
    const project = projector(base, machine);
    let minX = Infinity;
    for (const pr of first.pairs) {
      for (const s of pr.kerfStations) {
        const c = project(s.r, s.t);
        minX = Math.min(minX, c.left.x, c.right.x);
      }
    }
    if (!Number.isFinite(minX)) minX = b0.x0; // no cut yet (e.g. unmatched splits): use the outlines
    offset = { x: machine.travel.x[0] - minX, y: layout.floor - b0.y0 };
  }

  const b = { x0: b0.x0 + offset.x, x1: b0.x1 + offset.x, y0: b0.y0 + offset.y, y1: b0.y1 + offset.y };
  const { w: bw, h: bh } = layout.block;
  const block =
    bw > 0 && bh > 0
      ? {
          x: layout.alongChord === 'left' ? b.x0 : layout.alongChord === 'right' ? b.x1 - bw : (b.x0 + b.x1) / 2 - bw / 2,
          y: layout.vertical === 'bottom' ? b.y0 : layout.vertical === 'top' ? b.y1 - bh : (b.y0 + b.y1) / 2 - bh / 2,
          w: bw,
          h: bh,
        }
      : base.block;
  return { ...base, offset, block };
}

/** The block size that just holds the profiles, plus `margin` all round (and the profile distance along the wire). */
export function fitBlockSize(placed: JobSettings, outlines: Vec2[], margin: number): Layout['block'] {
  const b = bounds(outlines);
  return { w: b.x1 - b.x0 + 2 * margin, h: b.y1 - b.y0 + 2 * margin, len: (placed.profile.distance ?? placed.span) + 2 * margin };
}
