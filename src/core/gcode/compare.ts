import type { CarriagePos } from './writer';

type P4 = [number, number, number, number];
const p4 = (c: CarriagePos): P4 => [c.left.x, c.left.y, c.right.x, c.right.y];

function distToSeg4(p: P4, a: P4, b: P4): number {
  let ab2 = 0;
  let apab = 0;
  for (let i = 0; i < 4; i++) {
    ab2 += (b[i] - a[i]) ** 2;
    apab += (p[i] - a[i]) * (b[i] - a[i]);
  }
  const t = ab2 > 0 ? Math.max(0, Math.min(1, apab / ab2)) : 0;
  let d = 0;
  for (let i = 0; i < 4; i++) d += (p[i] - (a[i] + (b[i] - a[i]) * t)) ** 2;
  return Math.sqrt(d);
}

function oneWay(from: P4[], to: P4[]): number[] {
  return from.map((p) => {
    let best = Infinity;
    for (let i = 1; i < to.length; i++) best = Math.min(best, distToSeg4(p, to[i - 1], to[i]));
    return best;
  });
}

export interface PathDiff {
  max: number;
  rms: number;
  p95: number;
}

/**
 * Compare two carriage paths as curves in 4D (left X/Y + right X/Y), both directions.
 * Because it is 4D, it catches sync errors as well as shape errors.
 */
export function comparePaths(a: CarriagePos[], b: CarriagePos[]): PathDiff {
  const A = a.map(p4);
  const B = b.map(p4);
  const d = [...oneWay(A, B), ...oneWay(B, A)].sort((x, y) => x - y);
  const rms = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
  return { max: d[d.length - 1], rms, p95: d[Math.floor(d.length * 0.95)] };
}
