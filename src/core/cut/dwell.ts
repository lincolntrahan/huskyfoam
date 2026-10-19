import { cross, dot, sub, type Vec2 } from '../geom/vec';
import type { PathPt } from '../plan/walk';

const turn = (a: Vec2, b: Vec2) => Math.abs(Math.atan2(cross(a, b), dot(a, b)));
const moved = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y) > 1e-9;

/**
 * Path indices to pause after, for corner dwell. A corner is a run of consecutive points from
 * the same profile corner (a kerf arc, or a single miter point) on a cut; it counts when the direction going
 * in vs. coming out turns more than `angleDeg` on either face. The pause goes after the last
 * point of the corner, so the wire has finished rounding it before it heads off.
 */
export function findDwells(path: PathPt[], angleDeg: number): number[] {
  const lim = (angleDeg * Math.PI) / 180;
  const out: number[] = [];
  let i = 1;
  while (i < path.length - 1) {
    const k = path[i].corner;
    if (k < 0 || path[i].speed !== 'cut') {
      i++;
      continue;
    }
    let j = i;
    // stop at a different corner: two corners can touch when the edge between them has no inner points
    while (j + 1 < path.length - 1 && path[j + 1].corner === k && path[j + 1].speed === 'cut') j++;
    const before = path[i - 1];
    const after = path[j + 1];
    if (after.speed === 'cut') {
      const angle = (face: 'r' | 't') => {
        const a = path[i][face];
        const b = path[j][face];
        // directions in and out; skip a face that doesn't move (e.g. a held arc point)
        if (!moved(before[face], a) || !moved(b, after[face])) return 0;
        return turn(sub(a, before[face]), sub(after[face], b));
      };
      if (Math.max(angle('r'), angle('t')) > lim) out.push(j);
    }
    i = j + 1;
  }
  return out;
}
