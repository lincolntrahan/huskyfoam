import type { Edge } from '../io/dxf';
import { dist, type Vec2 } from './vec';

/**
 * A profile contour as a dense polyline. Closed contours run CCW with no repeated end point;
 * open ones run from one end to the other (`closed: false`).
 * `breaks` are indices where one source entity ends and the next begins; they are the
 * default split (sync) candidates.
 */
export interface Profile {
  pts: Vec2[];
  breaks: number[];
  /** False for an open contour (a line or arc that doesn't close). Absent = closed. */
  closed?: boolean;
}

export const isClosed = (p: Profile) => p.closed !== false;

export interface ChainResult {
  profile: Profile | null;
  warnings: string[];
  /** Indices (into the input edges) of the entities that make up the chosen outline. */
  edgeIds: number[];
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
  /** Input edge indices in this chain. */
  ids: number[];
}

/** Join edges end-to-end (reversing as needed) into chains, closing them when the ends meet. */
function buildChains(edges: Edge[], tol: number): Chain[] {
  const unused = edges.map((e, id) => ({ pts: e.pts, id })).filter((e) => e.pts.length >= 2);
  const chains: Chain[] = [];
  /** Take an unused edge that touches p, oriented to start at p. */
  const take = (p: Vec2): { pts: Vec2[]; id: number } | null => {
    for (let i = 0; i < unused.length; i++) {
      const e = unused[i].pts;
      const next = dist(e[0], p) <= tol ? e : dist(e[e.length - 1], p) <= tol ? e.slice().reverse() : null;
      if (!next) continue;
      const id = unused[i].id;
      unused.splice(i, 1);
      return { pts: next, id };
    }
    return null;
  };
  while (unused.length) {
    const first = unused.shift()!;
    let pts = first.pts.slice();
    let ids = [first.id];
    let breaks = [0];
    for (let e = take(pts[pts.length - 1]); e; e = take(pts[pts.length - 1])) {
      breaks.push(pts.length - 1);
      pts.push(...e.pts.slice(1));
      ids.push(e.id);
    }
    let closed = pts.length > 2 && dist(pts[0], pts[pts.length - 1]) <= tol;
    // an open chain may also continue backwards from its first point
    if (!closed) {
      for (let e = take(pts[0]); e; e = take(pts[0])) {
        const add = e.pts.slice(1).reverse();
        breaks = [0, ...breaks.map((b) => b + add.length)];
        pts = [...add, ...pts];
        ids = [e.id, ...ids];
      }
      closed = pts.length > 2 && dist(pts[0], pts[pts.length - 1]) <= tol;
    }
    if (closed) pts.pop();
    chains.push({ pts, breaks, closed, ids });
  }
  return chains;
}

/** Chain as a profile: closed ones CCW, open ones as drawn. */
function toProfile(c: Chain): Profile {
  let { pts, breaks } = c;
  if (!c.closed) {
    breaks = [...new Set([...breaks, pts.length - 1])].sort((a, b) => a - b);
    return { pts, breaks, closed: false };
  }
  if (signedArea(pts) < 0) {
    const n = pts.length;
    pts = pts.slice().reverse();
    breaks = breaks.map((b) => (n - 1 - b + n) % n);
  }
  breaks = [...new Set(breaks)].sort((a, b) => a - b);
  return { pts, breaks };
}

export interface ChainSetResult {
  /** Outer (largest closed) contour first, then the other closed ones by size, then open ones. */
  contours: Profile[];
  warnings: string[];
  /** Input edge indices per contour. */
  edgeIds: number[][];
}

/** Turn imported edges into every contour they form, closed or open. */
export function chainProfiles(edges: Edge[], tol = 1e-3): ChainSetResult {
  const chains = buildChains(edges, tol).filter((c) => c.pts.length >= 2);
  const area = (c: Chain) => (c.closed ? Math.abs(signedArea(c.pts)) : -1);
  chains.sort((a, b) => area(b) - area(a));
  return {
    contours: chains.map(toProfile),
    edgeIds: chains.map((c) => c.ids.slice().sort((a, b) => a - b)),
    warnings: [],
  };
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
      edgeIds: [],
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
  return { profile: { pts, breaks }, warnings, edgeIds: best.ids.slice().sort((a, b) => a - b) };
}

export function transformProfile(p: Profile, f: (v: Vec2) => Vec2): Profile {
  return { ...p, pts: p.pts.map(f), breaks: p.breaks.slice() };
}
