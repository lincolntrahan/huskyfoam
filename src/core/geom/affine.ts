import type { Vec2 } from './vec';

/** 2D affine map: (x, y) -> (a·x + c·y + e, b·x + d·y + f). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const translate = (t: Vec2): Affine => ({ a: 1, b: 0, c: 0, d: 1, e: t.x, f: t.y });
export const scaleXY = (sx: number, sy: number): Affine => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
export function rotation(rad: number): Affine {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

/** m ∘ n: apply n first, then m. */
export function compose(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** Compose left to right in the order they are applied: chain(first, second, ...). */
export const chain = (...ms: Affine[]): Affine => ms.reduce((acc, m) => compose(m, acc), IDENTITY);

export const applyAffine = (m: Affine, p: Vec2): Vec2 => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

export const det = (m: Affine) => m.a * m.d - m.b * m.c;

export function invert(m: Affine): Affine {
  const k = det(m);
  const a = m.d / k;
  const b = -m.b / k;
  const c = -m.c / k;
  const d = m.a / k;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** True when the map is a pure translation (no rotation, scale or flip). */
export const isTranslation = (m: Affine) => m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
