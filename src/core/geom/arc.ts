import { isClosed, type Profile } from './profile';
import { dist, distToSegment, dot, lerp, sub, type Vec2 } from './vec';

/**
 * Arc-length view of a profile contour: positions are distances along it from pts[0], in
 * [0, length) on a closed loop and [0, length] on an open contour. Lets splits and pins sit
 * anywhere, not only on dense vertices.
 */
export interface ArcLoop {
  /** Dense points; a closed loop repeats its first point at the end. */
  pts: Vec2[];
  /** cum[i] = arc length at pts[i]; cum[last] = total length. */
  cum: number[];
  length: number;
  /** False for an open contour: positions don't wrap. Absent = closed. */
  closed?: boolean;
}

export function arcLoop(profile: Profile): ArcLoop {
  const closed = isClosed(profile);
  const pts = closed ? [...profile.pts, profile.pts[0]] : profile.pts.slice();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return closed ? { pts, cum, length: cum[cum.length - 1] } : { pts, cum, length: cum[cum.length - 1], closed: false };
}

export const arcClosed = (a: ArcLoop) => a.closed !== false;

/** Wrap a position onto a closed loop; clamp it onto an open contour. */
export const wrapS = (a: ArcLoop, s: number) => (arcClosed(a) ? ((s % a.length) + a.length) % a.length : Math.min(Math.max(s, 0), a.length));

/** Arc length at dense vertex i. */
export const sAtIndex = (a: ArcLoop, i: number) => a.cum[i];

export function pointAtS(a: ArcLoop, sIn: number): Vec2 {
  const s = wrapS(a, sIn);
  let lo = 0;
  let hi = a.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = a.cum[hi] - a.cum[lo];
  return span > 0 ? lerp(a.pts[lo], a.pts[hi], (s - a.cum[lo]) / span) : a.pts[lo];
}

/** Arc position of the point on the loop nearest to p. */
export function nearestS(a: ArcLoop, p: Vec2): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 1; i < a.pts.length; i++) {
    const d = distToSegment(p, a.pts[i - 1], a.pts[i]);
    if (d < best.d) {
      const ab = sub(a.pts[i], a.pts[i - 1]);
      const l2 = dot(ab, ab);
      const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a.pts[i - 1]), ab) / l2)) : 0;
      best = { s: wrapS(a, a.cum[i - 1] + t * (a.cum[i] - a.cum[i - 1])), d };
    }
  }
  return best;
}

/** Forward (CCW) distance from sA to sB, in (0, length] (open contours: sB - sA, never wrapping). */
export function spanS(a: ArcLoop, sA: number, sB: number): number {
  if (!arcClosed(a)) return Math.max(0, sB - sA);
  const d = wrapS(a, sB - sA);
  return d === 0 ? a.length : d;
}

/** True if s lies strictly inside the forward stretch from sA to sB. */
export function withinS(a: ArcLoop, sA: number, sB: number, s: number): boolean {
  if (!arcClosed(a)) return s > sA && s < sB;
  const d = wrapS(a, s - sA);
  return d > 0 && d < spanS(a, sA, sB);
}

/**
 * The polyline from sA forward to sB: interpolated end points plus every dense vertex
 * strictly between. sA === sB gives the whole loop.
 */
export function sliceS(a: ArcLoop, sA: number, sB: number): Vec2[] {
  const out = [pointAtS(a, sA)];
  if (!arcClosed(a)) {
    for (let i = 0; i < a.pts.length; i++) if (a.cum[i] > sA && a.cum[i] < sB) out.push(a.pts[i]);
    out.push(pointAtS(a, sB));
    return out;
  }
  const total = spanS(a, sA, sB);
  const start = wrapS(a, sA);
  const n = a.pts.length - 1; // unique vertices
  // first vertex strictly after sA
  let i = a.cum.findIndex((c) => c > start);
  if (i < 0 || i >= n) i = n; // wraps to vertex 0 (at arc length `length`)
  for (let k = 0; k < n; k++) {
    const idx = (i + k) % n;
    let d = a.cum[idx] - start;
    if (d <= 0) d += a.length;
    if (d >= total) break;
    out.push(a.pts[idx]);
  }
  out.push(pointAtS(a, sB));
  return out;
}
