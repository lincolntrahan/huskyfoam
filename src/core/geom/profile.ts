import type { Edge } from '../io/dxf';
import { dist, type Vec2 } from './vec';

/**
 * A closed profile as a dense CCW polyline (no repeated end point).
 * `breaks` are indices where one source entity ends and the next begins; they are the
 * default split (sync) candidates.
 */
export interface Profile {
  pts: Vec2[];
  breaks: number[];
}

export interface ChainResult {
  profile: Profile | null;
  warnings: string[];
}

export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

interface Chain {
  pts: Vec2[];
  breaks: number[];
  closed: boolean;
}

/** Join edges end-to-end (reversing as needed) into chains, closing them when the ends meet. */
function buildChains(edges: Edge[], tol: number): Chain[] {
  const unused = edges.map((e) => e.pts).filter((p) => p.length >= 2);
  const chains: Chain[] = [];
  while (unused.length) {
    const first = unused.shift()!;
    const pts = first.slice();
    const breaks = [0];
    let extended = true;
    while (extended) {
      extended = false;
      const end = pts[pts.length - 1];
      for (let i = 0; i < unused.length; i++) {
        const e = unused[i];
        let next: Vec2[] | null = null;
        if (dist(e[0], end) <= tol) next = e;
        else if (dist(e[e.length - 1], end) <= tol) next = e.slice().reverse();
        if (!next) continue;
        breaks.push(pts.length - 1);
        pts.push(...next.slice(1));
        unused.splice(i, 1);
        extended = true;
        break;
      }
    }
    const closed = pts.length > 2 && dist(pts[0], pts[pts.length - 1]) <= tol;
    if (closed) pts.pop();
    chains.push({ pts, breaks, closed });
  }
  return chains;
}

/**
 * Turn imported edges into one closed CCW profile. Picks the biggest closed loop; anything
 * else is reported (M1 cuts a single outer loop).
 */
export function chainProfile(edges: Edge[], tol = 1e-3): ChainResult {
  const warnings: string[] = [];
  const chains = buildChains(edges, tol);
  const closed = chains.filter((c) => c.closed);
  if (!closed.length) {
    const ends = chains.length;
    return {
      profile: null,
      warnings: [`No closed outline found (${ends} open chain${ends === 1 ? '' : 's'}). Check for gaps bigger than ${tol} between entities.`],
    };
  }
  closed.sort((a, b) => Math.abs(signedArea(b.pts)) - Math.abs(signedArea(a.pts)));
  const best = closed[0];
  const extra = chains.length - 1;
  if (extra > 0) warnings.push(`Using the largest closed outline; ignored ${extra} other loop${extra === 1 ? '' : 's'} or open chain${extra === 1 ? '' : 's'}.`);

  let { pts, breaks } = best;
  if (signedArea(pts) < 0) {
    const n = pts.length;
    pts = pts.slice().reverse();
    breaks = breaks.map((b) => (n - 1 - b + n) % n);
  }
  breaks = [...new Set(breaks)].sort((a, b) => a - b);
  return { profile: { pts, breaks }, warnings };
}

export function transformProfile(p: Profile, f: (v: Vec2) => Vec2): Profile {
  return { pts: p.pts.map(f), breaks: p.breaks.slice() };
}
