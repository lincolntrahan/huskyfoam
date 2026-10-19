import type { Profile } from '../geom/profile';
import { cross, dot, sub, type Vec2 } from '../geom/vec';

/** Turning angle (radians, + = left) at dense vertex i of a closed polyline. */
export function turnAngle(pts: Vec2[], i: number): number {
  const n = pts.length;
  const a = sub(pts[i], pts[(i - 1 + n) % n]);
  const b = sub(pts[(i + 1) % n], pts[i]);
  return Math.atan2(cross(a, b), dot(a, b));
}

/** Default split points: every entity boundary plus every corner sharper than cornerDeg. */
export function autoSplits(profile: Profile, cornerDeg: number): number[] {
  const set = new Set(profile.breaks);
  const lim = (cornerDeg * Math.PI) / 180;
  for (let i = 0; i < profile.pts.length; i++) {
    if (Math.abs(turnAngle(profile.pts, i)) > lim) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Default loop start: the split furthest toward -X (ties broken toward -Y). For a wing with
 * a leading-edge tab that is the bottom corner of the tab, which matches DevFoam's start.
 */
export function defaultStart(profile: Profile, splits: number[]): number {
  let best = splits[0];
  for (const s of splits) {
    const p = profile.pts[s];
    const b = profile.pts[best];
    const tol = 1e-4;
    if (p.x < b.x - tol || (Math.abs(p.x - b.x) <= tol && p.y < b.y)) best = s;
  }
  return best;
}

/** Cut a closed profile into segments between consecutive splits, starting at `start`. */
export function segmentsFrom(profile: Profile, splits: number[], start: number): Vec2[][] {
  const n = profile.pts.length;
  const k0 = splits.indexOf(start);
  if (k0 < 0) throw new Error('loop start must be one of the splits');
  const ordered = [...splits.slice(k0), ...splits.slice(0, k0)];
  const segs: Vec2[][] = [];
  for (let k = 0; k < ordered.length; k++) {
    const a = ordered[k];
    const b = ordered[(k + 1) % ordered.length];
    const seg: Vec2[] = [];
    let i = a;
    seg.push(profile.pts[i]);
    do {
      i = (i + 1) % n;
      seg.push(profile.pts[i]);
    } while (i !== b);
    segs.push(seg);
  }
  return segs;
}
