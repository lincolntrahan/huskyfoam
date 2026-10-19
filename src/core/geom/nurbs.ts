import type { Vec2 } from './vec';

export interface NurbsCurve {
  degree: number;
  knots: number[];
  ctrl: Vec2[];
  /** Optional; all 1 when omitted. */
  weights?: number[];
}

function findSpan(n: number, p: number, u: number, U: number[]): number {
  // n = index of last control point
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** Evaluate a (rational) B-spline at parameter u with de Boor's algorithm. */
export function evalNurbs(c: NurbsCurve, u: number): Vec2 {
  const p = c.degree;
  const U = c.knots;
  const n = c.ctrl.length - 1;
  const k = findSpan(n, p, u, U);
  const d: { x: number; y: number; w: number }[] = [];
  for (let j = 0; j <= p; j++) {
    const i = k - p + j;
    const w = c.weights?.[i] ?? 1;
    d.push({ x: c.ctrl[i].x * w, y: c.ctrl[i].y * w, w });
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const denom = U[i + p - r + 1] - U[i];
      const a = denom === 0 ? 0 : (u - U[i]) / denom;
      d[j] = {
        x: (1 - a) * d[j - 1].x + a * d[j].x,
        y: (1 - a) * d[j - 1].y + a * d[j].y,
        w: (1 - a) * d[j - 1].w + a * d[j].w,
      };
    }
  }
  const r = d[p];
  return { x: r.x / r.w, y: r.y / r.w };
}

/** Dense polyline approximation, sampling every non-empty knot span evenly. */
export function flattenNurbs(c: NurbsCurve, perSpan = 64): Vec2[] {
  const p = c.degree;
  const U = c.knots;
  const n = c.ctrl.length - 1;
  const u0 = U[p];
  const u1 = U[n + 1];
  const pts: Vec2[] = [];
  for (let i = p; i <= n; i++) {
    const a = Math.max(U[i], u0);
    const b = Math.min(U[i + 1], u1);
    if (b <= a) continue;
    for (let s = 0; s < perSpan; s++) pts.push(evalNurbs(c, a + ((b - a) * s) / perSpan));
  }
  pts.push(evalNurbs(c, u1));
  return pts;
}
