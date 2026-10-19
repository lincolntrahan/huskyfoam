import { add, cross, dot, dist, normalize, perpR, rotate, scale, sub, type Vec2 } from '../geom/vec';

/** One synced pair of points: r on the root face, t on the tip face. */
export interface Station {
  r: Vec2;
  t: Vec2;
  /** Index of the segment this station starts (or lies in). */
  seg: number;
  /** True for the first station of a segment (a split point). */
  boundary: boolean;
  /** Set by offsetStations: part of the corner (arc or single miter point) at the segment's start split. */
  corner?: boolean;
}

const EPS = 1e-9;
const CORNER_MIN = (1 * Math.PI) / 180;
const ARC_STEP = (10 * Math.PI) / 180;

interface SideCorner {
  /** Offset point for step j of m (m = 0 means a single point). */
  at: (j: number, m: number) => Vec2;
  /** Arc steps this face needs at this station (0 = no arc). */
  arcCount: number;
}

/** The next distinct point in direction dir; null past the end of an open contour. */
function neighbor(pts: Vec2[], i: number, dir: 1 | -1, closed: boolean): Vec2 | null {
  const n = pts.length;
  for (let k = 1; k < n; k++) {
    const j = i + dir * k;
    if (!closed && (j < 0 || j >= n)) return null;
    const q = pts[((j % n) + n) % n];
    if (dist(q, pts[i]) > EPS) return q;
  }
  return null;
}

function sideCorner(pts: Vec2[], i: number, h: number, isBoundary: boolean, closed: boolean): SideCorner {
  const p = pts[i];
  const before = neighbor(pts, i, -1, closed);
  const after = neighbor(pts, i, 1, closed);
  // the ends of an open contour carry straight on
  let dIn = before ? normalize(sub(p, before)) : null;
  let dOut = after ? normalize(sub(after, p)) : null;
  dIn ??= dOut ?? { x: 1, y: 0 };
  dOut ??= dIn;
  const nIn = perpR(dIn);
  const nOut = perpR(dOut);
  const theta = Math.atan2(cross(dIn, dOut), dot(dIn, dOut));

  if (isBoundary && theta > CORNER_MIN && h > 0) {
    // Convex corner (left turn on a CCW loop): the outward offset opens a gap -> round it.
    return {
      at: (j, m) => add(p, scale(rotate(nIn, m ? (theta * j) / m : 0), h)),
      arcCount: Math.max(1, Math.ceil(theta / ARC_STEP)),
    };
  }
  let q: Vec2;
  if (isBoundary && theta < -CORNER_MIN) {
    // Concave corner: the two offset lines meet at the miter point.
    const denom = Math.max(1 + dot(nIn, nOut), 0.1);
    q = add(p, scale(add(nIn, nOut), h / denom));
  } else {
    // Smooth: offset along the averaged normal, scaled so the offset lines stay h away.
    const n = normalize(add(nIn, nOut));
    q = add(p, scale(n, h / Math.max(dot(n, nIn), 0.3)));
  }
  return { at: () => q, arcCount: 0 };
}

/**
 * Which way the wire offsets from the drawn path: to the right of the direction of travel
 * (outward on a CCW loop), to the left (into a CCW hole), or not at all.
 */
export type OffsetSide = 'right' | 'left' | 'none';

/**
 * Offset every station by half the kerf on each face, keeping root and tip in sync.
 * Convex corners get an arc with the same number of points on both faces; a face that does
 * not need an arc at that station just holds its point.
 * `stations` is a closed loop without the repeated closing station, or with `open` an open
 * contour from end to end. By default the offset goes right of travel (outward on CCW).
 */
export function offsetStations(
  stations: Station[],
  kerfRoot: (i: number, seg: number) => number,
  kerfTip: (i: number, seg: number) => number,
  opts: { open?: boolean; side?: OffsetSide } = {},
): Station[] {
  const side = opts.side ?? 'right';
  if (side === 'left') {
    // offsetting left = offsetting right while travelling the other way
    const n = stations.length;
    const rev = offsetStations(stations.slice().reverse(), (i, seg) => kerfRoot(n - 1 - i, seg), (i, seg) => kerfTip(n - 1 - i, seg), { ...opts, side: 'right' });
    return rev.reverse();
  }
  const closed = !opts.open;
  const R = stations.map((s) => s.r);
  const T = stations.map((s) => s.t);
  const out: Station[] = [];
  stations.forEach((s, i) => {
    const kr = side === 'none' ? 0 : kerfRoot(i, s.seg);
    const kt = side === 'none' ? 0 : kerfTip(i, s.seg);
    const cr = sideCorner(R, i, kr / 2, s.boundary, closed);
    const ct = sideCorner(T, i, kt / 2, s.boundary, closed);
    const m = Math.max(cr.arcCount, ct.arcCount);
    for (let j = 0; j <= m; j++) {
      out.push({ r: cr.at(j, m), t: ct.at(j, m), seg: s.seg, boundary: s.boundary && j === 0, corner: s.boundary });
    }
  });
  return out;
}
