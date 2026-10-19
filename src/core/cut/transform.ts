import { applyAffine, chain, invert, rotation, scaleXY, translate, type Affine } from '../geom/affine';
import { arcClosed, wrapS, type ArcLoop } from '../geom/arc';
import { resolveChord } from '../geom/chord';
import type { Profile } from '../geom/profile';
import { add, lerp, type Vec2 } from '../geom/vec';
import type { SyncSettings } from '../sync/sync';

/** Per-profile transform (SPEC M2b PR 2). Applied about the pivot: flip -> scale -> twist -> move. */
export interface ProfileTransform {
  /** Extra twist in degrees, positive = leading edge up. Added on top of any twist drawn in CAD. */
  twistDeg: number;
  scale: number;
  move: Vec2;
  pivot: 'quarter' | 'le' | 'te' | 'point';
  /** Used when pivot = 'point' (raw profile coordinates). */
  pivotPoint: Vec2;
  /** LE / TE overrides as arc positions on the raw outline; null = automatic (ignores tabs). */
  le: number | null;
  te: number | null;
}

export interface Transforms {
  /** Edits to scale / move / pivot apply to both profiles. Twist is always per profile. */
  link: boolean;
  /** Flips always apply to both profiles (flipping one alone would turn the wire inside out). */
  flipH: boolean;
  flipV: boolean;
  root: ProfileTransform;
  tip: ProfileTransform;
}

export const defaultProfileTransform = (): ProfileTransform => ({
  twistDeg: 0,
  scale: 1,
  move: { x: 0, y: 0 },
  pivot: 'quarter',
  pivotPoint: { x: 0, y: 0 },
  le: null,
  te: null,
});

export const defaultTransforms = (): Transforms => ({
  link: true,
  flipH: false,
  flipV: false,
  root: defaultProfileTransform(),
  tip: defaultProfileTransform(),
});

export interface SideTransform {
  /** Raw profile coordinates -> machine face coordinates (includes the part offset). */
  affine: Affine;
  inverse: Affine;
  /** Odd number of flips: the outline's direction reverses. */
  mirrored: boolean;
  /** Length scale factor. */
  k: number;
  /** Raw arc position of raw pts[n-1], needed to map positions when mirrored. */
  lastS: number;
  /** In raw coordinates. */
  chord: { le: Vec2; te: Vec2; pivot: Vec2 };
}

const isIdentity = (t: ProfileTransform, flipH: boolean, flipV: boolean) =>
  t.twistDeg === 0 && t.scale === 1 && t.move.x === 0 && t.move.y === 0 && !flipH && !flipV;

export function sideTransform(p: Profile, arc: ArcLoop, t: ProfileTransform, flipH: boolean, flipV: boolean, offset: Vec2): SideTransform {
  const chordPts = resolveChord(p, arc, t.le, t.te);
  const pivot =
    t.pivot === 'le' ? chordPts.le : t.pivot === 'te' ? chordPts.te : t.pivot === 'point' ? t.pivotPoint : lerp(chordPts.le, chordPts.te, 0.25);
  const lastS = arc.cum[arc.pts.length - 2];
  const chord = { ...chordPts, pivot };
  if (isIdentity(t, flipH, flipV)) {
    // pure translation, kept exact so untransformed jobs give bit-identical output
    const affine = translate(offset);
    return { affine, inverse: invert(affine), mirrored: false, k: 1, lastS, chord };
  }
  const fx = flipH ? -1 : 1;
  const fy = flipV ? -1 : 1;
  // positive twist raises the LE: rotate toward the side the (flipped) LE is on
  const leSide = (chordPts.le.x - pivot.x) * fx < 0 ? -1 : 1;
  const phi = (leSide * t.twistDeg * Math.PI) / 180;
  const affine = chain(translate({ x: -pivot.x, y: -pivot.y }), scaleXY(t.scale * fx, t.scale * fy), rotation(phi), translate(add(add(pivot, t.move), offset)));
  return { affine, inverse: invert(affine), mirrored: flipH !== flipV, k: Math.abs(t.scale), lastS, chord };
}

/** Transform a raw profile; mirrored outlines are reversed so they stay CCW (kerf stays outside). */
/**
 * Transform a raw contour. Mirrored contours are reversed so closed ones stay CCW (kerf stays
 * outside) and open ones keep their kerf on the same side of the material.
 */
export function applyToProfile(p: Profile, st: SideTransform): Profile {
  const pts = p.pts.map((q) => applyAffine(st.affine, q));
  if (!st.mirrored) return { ...p, pts, breaks: p.breaks.slice() };
  const n = pts.length;
  return { ...p, pts: pts.reverse(), breaks: p.breaks.map((b) => (n - 1 - b + n) % n).sort((a, b) => a - b) };
}

// Arc positions: raw outline <-> transformed outline (for any contour of that side).
// Raw arc position of the reversed outline's first point: the last dense vertex (closed) or the end (open).
const lastS = (raw: ArcLoop) => (arcClosed(raw) ? raw.cum[raw.pts.length - 2] : raw.length);
function sToT(st: SideTransform, raw: ArcLoop, s: number): number {
  if (!st.mirrored) return st.k * s;
  if (!arcClosed(raw)) return st.k * (raw.length - s);
  // the reversed outline starts at raw pts[n-1] and runs backwards
  return st.k * ((((lastS(raw) - s) % raw.length) + raw.length) % raw.length);
}
const sToRaw = (st: SideTransform, raw: ArcLoop, sT: number) => (st.mirrored ? wrapS(raw, lastS(raw) - sT / st.k) : sT / st.k);
// A mirrored loop runs the other way: keep the loop start, reverse the rest. An open contour reverses entirely.
const reorder = <T,>(list: T[], mirrored: boolean, closed = true) => (!mirrored ? list : closed ? [list[0], ...list.slice(1).reverse()] : list.slice().reverse());
// flips apply to both profiles, so the root's direction stands for both
const withLinked = (sync: SyncSettings, mirrored: boolean, closed: boolean) => (sync.linked ? { linked: reorder(sync.linked, mirrored, closed) } : {});

export function syncToTransformed(sync: SyncSettings, st: { root: SideTransform; tip: SideTransform }, raw: { root: ArcLoop; tip: ArcLoop }): SyncSettings {
  const side = (k: 'root' | 'tip') => reorder(sync[k].map((s) => sToT(st[k], raw[k], s)), st[k].mirrored, arcClosed(raw[k]));
  return {
    root: side('root'),
    tip: side('tip'),
    pins: sync.pins.map((p) => ({ root: sToT(st.root, raw.root, p.root), tip: sToT(st.tip, raw.tip, p.tip), ...(p.linked ? { linked: true } : {}) })),
    ...withLinked(sync, st.root.mirrored, arcClosed(raw.root)),
  };
}

export function syncToRaw(sync: SyncSettings, st: { root: SideTransform; tip: SideTransform }, raw: { root: ArcLoop; tip: ArcLoop }): SyncSettings {
  const side = (k: 'root' | 'tip') => reorder(sync[k], st[k].mirrored, arcClosed(raw[k])).map((s) => sToRaw(st[k], raw[k], s));
  return {
    root: side('root'),
    tip: side('tip'),
    pins: sync.pins.map((p) => ({ root: sToRaw(st.root, raw.root, p.root), tip: sToRaw(st.tip, raw.tip, p.tip), ...(p.linked ? { linked: true } : {}) })),
    ...withLinked(sync, st.root.mirrored, arcClosed(raw.root)),
  };
}
