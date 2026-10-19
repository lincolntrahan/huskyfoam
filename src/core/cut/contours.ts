import { nearestS, type ArcLoop } from '../geom/arc';
import { isClosed, type Profile } from '../geom/profile';
import { dist, type Vec2 } from '../geom/vec';
import type { OffsetSide } from './kerf';

/**
 * Which side the wire's kerf goes for one contour pair. Closed contours: outside or inside the
 * loop. Open contours: left or right of the direction they were drawn in. 'auto': outside for
 * the outer contour and anything not inside it, inside for holes, none for open contours.
 */
export type KerfSide = 'auto' | 'outside' | 'inside' | 'left' | 'right' | 'none';

function bbox(pts: Vec2[]) {
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
  return { x0, y0, w: Math.max(x1 - x0, 1e-9), h: Math.max(y1 - y0, 1e-9) };
}

const centroid = (pts: Vec2[]): Vec2 => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
};

/** Point-in-polygon (even-odd). */
export function insidePolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Pair root contours with tip contours by where they sit relative to each side's outer contour
 * (contour 0), which always pairs with contour 0. Returns, for each root contour, the tip
 * contour it pairs with or -1.
 */
export function autoPairs(root: Profile[], tip: Profile[]): number[] {
  if (!root.length) return [];
  const out = root.map(() => -1);
  if (!tip.length) return out;
  out[0] = 0;
  const frame = (list: Profile[]) => {
    const b = bbox(list[0].pts);
    return list.map((p) => {
      const c = centroid(p.pts);
      const s = bbox(p.pts);
      return { closed: isClosed(p), u: (c.x - b.x0) / b.w, v: (c.y - b.y0) / b.h, size: Math.hypot(s.w / b.w, s.h / b.h) };
    });
  };
  const R = frame(root);
  const T = frame(tip);
  const cand: { r: number; t: number; cost: number }[] = [];
  for (let r = 1; r < R.length; r++) {
    for (let t = 1; t < T.length; t++) {
      if (R[r].closed !== T[t].closed) continue;
      cand.push({ r, t, cost: Math.hypot(R[r].u - T[t].u, R[r].v - T[t].v) + 0.5 * Math.abs(R[r].size - T[t].size) });
    }
  }
  cand.sort((a, b) => a.cost - b.cost);
  const usedT = new Set<number>();
  for (const c of cand) {
    if (out[c.r] >= 0 || usedT.has(c.t)) continue;
    out[c.r] = c.t;
    usedT.add(c.t);
  }
  return out;
}

/** Resolve a pair's kerf side to the direction the offset goes along its (CCW / as-drawn) path. */
export function offsetSide(side: KerfSide, contour: Profile, outer: Profile, isOuter: boolean): OffsetSide {
  if (side === 'none') return 'none';
  if (side === 'left') return 'left';
  if (side === 'right') return 'right';
  if (!isClosed(contour)) return side === 'auto' ? 'none' : side === 'outside' ? 'right' : 'left';
  if (side === 'outside') return 'right';
  if (side === 'inside') return 'left';
  // auto: holes (inside the outer contour) keep their kerf inside the hole
  if (isOuter || !isClosed(outer)) return 'right';
  return insidePolygon(contour.pts[0], outer.pts) ? 'left' : 'right';
}

/** The automatic choice, as shown in the UI. */
export function autoKerfSide(contour: Profile, outer: Profile, isOuter: boolean): KerfSide {
  const s = offsetSide('auto', contour, outer, isOuter);
  if (!isClosed(contour)) return 'none';
  return s === 'left' ? 'inside' : 'outside';
}

/** Arc positions of the closest points between two contours: on `a`, and on `b`. */
export function closestBetween(a: ArcLoop, b: ArcLoop): { sa: number; sb: number; d: number } {
  let best = { sa: 0, sb: 0, d: Infinity };
  const step = Math.max(1, Math.floor(b.pts.length / 400));
  for (let i = 0; i < b.pts.length; i += step) {
    const hit = nearestS(a, b.pts[i]);
    if (hit.d < best.d) best = { sa: hit.s, sb: b.cum[i], d: hit.d };
  }
  // refine on b around the best vertex
  const back = nearestS(b, pointOn(a, best.sa));
  return { sa: best.sa, sb: back.s, d: back.d };
}

function pointOn(a: ArcLoop, s: number): Vec2 {
  let i = a.cum.findIndex((c) => c >= s);
  if (i <= 0) return a.pts[Math.max(i, 0)];
  const f = (s - a.cum[i - 1]) / Math.max(a.cum[i] - a.cum[i - 1], 1e-12);
  return { x: a.pts[i - 1].x + f * (a.pts[i].x - a.pts[i - 1].x), y: a.pts[i - 1].y + f * (a.pts[i].y - a.pts[i - 1].y) };
}

/** Index of the split point nearest to p. */
export function nearestSplit(splitPts: Vec2[], p: Vec2): number {
  let best = 0;
  splitPts.forEach((q, k) => {
    if (dist(q, p) < dist(splitPts[best], p)) best = k;
  });
  return best;
}
