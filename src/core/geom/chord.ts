import { pointAtS, type ArcLoop } from './arc';
import type { Profile } from './profile';
import { cross, dist, sub, type Vec2 } from './vec';

/** Dense-point indices of each source entity (between consecutive entity boundaries). */
function entities(p: Profile): number[][] {
  const n = p.pts.length;
  const b = p.breaks.length ? p.breaks : [0];
  return b.map((start, k) => {
    const end = b[(k + 1) % b.length];
    const idx = [start];
    let i = start;
    do {
      i = (i + 1) % n;
      idx.push(i);
    } while (i !== end);
    return idx;
  });
}

function isStraight(pts: Vec2[], idx: number[]): boolean {
  const a = pts[idx[0]];
  const b = pts[idx[idx.length - 1]];
  const L = dist(a, b);
  if (idx.length <= 2) return true;
  if (L === 0) return false;
  return idx.every((i) => Math.abs(cross(sub(b, a), sub(pts[i], a))) / L < 1e-9 * Math.max(1, L));
}

/**
 * Leading and trailing edge points of a raw profile, ignoring tabs.
 * When the profile has curved entities (splines, arcs) only their points count, so straight
 * tab lines sticking out past the airfoil are skipped. Pure polylines fall back to the whole
 * profile minus long straight edges. Ties at the extreme X are averaged, so a blunt LE or an
 * open TE gives the middle of the gap (on the chord line).
 */
export function autoChord(p: Profile): { le: Vec2; te: Vec2 } {
  const ents = entities(p);
  let cand = ents.filter((e) => !isStraight(p.pts, e)).flat();
  if (!cand.length) {
    const xs = p.pts.map((q) => q.x);
    const width = Math.max(...xs) - Math.min(...xs);
    cand = ents.filter((e) => dist(p.pts[e[0]], p.pts[e[e.length - 1]]) < 0.05 * width).flat();
  }
  if (!cand.length) cand = p.pts.map((_, i) => i);
  // CAD exports leave the two ends of a blunt LE / open TE a hair apart in X; treat them as a tie
  const xs = cand.map((i) => p.pts[i].x);
  const tol = Math.max(1e-6, 2e-4 * (Math.max(...xs) - Math.min(...xs)));
  const extreme = (sign: 1 | -1): Vec2 => {
    const best = Math.max(...cand.map((i) => sign * p.pts[i].x));
    const at = [...new Set(cand.filter((i) => Math.abs(sign * p.pts[i].x - best) <= tol))];
    // x at the extreme; y in the middle of the tied points (mid-gap for a blunt end, the nose for a round one)
    const ys = at.map((i) => p.pts[i].y);
    return { x: sign * best, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  };
  return { le: extreme(-1), te: extreme(1) };
}

/** LE/TE for a profile: automatic, or overridden by arc positions on the outline. */
export function resolveChord(p: Profile, arc: ArcLoop, le: number | null, te: number | null): { le: Vec2; te: Vec2 } {
  const auto = le === null || te === null ? autoChord(p) : null;
  return { le: le === null ? auto!.le : pointAtS(arc, le), te: te === null ? auto!.te : pointAtS(arc, te) };
}
