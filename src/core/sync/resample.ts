import { distToSegment, dist, lerp, type Vec2 } from '../geom/vec';
import type { SamplingSettings } from '../types';

export function cumulative(pts: Vec2[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
  return c;
}

/** Point at normalized arc length t in [0,1]. */
export function pointAt(pts: Vec2[], cum: number[], t: number): Vec2 {
  const L = cum[cum.length - 1];
  const s = t * L;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  return span > 0 ? lerp(pts[lo], pts[hi], (s - cum[lo]) / span) : pts[lo];
}

/** Douglas-Peucker: indices of the points needed to stay within tol of the polyline. */
function simplify(pts: Vec2[], tol: number): number[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}

/**
 * Resample a matched pair of segments to the same number of points, matched by normalized
 * arc length. Both endpoints are included.
 */
export function resamplePair(a: Vec2[], b: Vec2[], s: SamplingSettings): { a: Vec2[]; b: Vec2[] } {
  const ca = cumulative(a);
  const cb = cumulative(b);
  const La = ca[ca.length - 1];
  const Lb = cb[cb.length - 1];
  const Lmax = Math.max(La, Lb, 1e-12);

  let ts: number[];
  if (s.mode === 'uniform') {
    const n = Math.max(1, Math.ceil(Lmax / s.step - 1e-9));
    ts = Array.from({ length: n + 1 }, (_, i) => i / n);
  } else {
    const raw = [0, 1];
    for (const i of simplify(a, s.tolerance)) raw.push(La > 0 ? ca[i] / La : 0);
    for (const i of simplify(b, s.tolerance)) raw.push(Lb > 0 ? cb[i] / Lb : 0);
    raw.sort((x, y) => x - y);
    // drop near-duplicates (closer than 1% of maxStep on the longer side)
    const minDt = (0.01 * s.maxStep) / Lmax;
    const uniq: number[] = [0];
    for (const t of raw) if (t - uniq[uniq.length - 1] > minDt) uniq.push(t);
    if (1 - uniq[uniq.length - 1] <= minDt) uniq[uniq.length - 1] = 1;
    else uniq.push(1);
    // fill gaps longer than maxStep
    ts = [0];
    for (let i = 1; i < uniq.length; i++) {
      const t0 = uniq[i - 1];
      const t1 = uniq[i];
      const n = Math.max(1, Math.ceil(((t1 - t0) * Lmax) / s.maxStep - 1e-9));
      for (let k = 1; k <= n; k++) ts.push(t0 + ((t1 - t0) * k) / n);
    }
  }
  return { a: ts.map((t) => pointAt(a, ca, t)), b: ts.map((t) => pointAt(b, cb, t)) };
}
