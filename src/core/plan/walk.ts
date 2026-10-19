import type { Station } from '../cut/kerf';
import { dist, type Vec2 } from '../geom/vec';
import { asTopology, segEndSplit, segSplits, segStartSplit, type CutPlan, type PlanPoint, type PlanStep, type Speed, type Topo } from './model';

export interface FacePt {
  r: Vec2;
  t: Vec2;
}

/** One point of the walked face path; `speed`/`step` describe the move that arrives here. */
export interface PathPt extends FacePt {
  speed: Speed | 'gap';
  step: number;
  /** Arrived at via an inserted line (vs. a profile segment). */
  line: boolean;
  /** Split index of the profile corner (kerf arc or miter point) this point belongs to, or -1. Used to find corners for dwell. */
  corner: number;
}

export interface Gap {
  /** Index of the step that should have started where the previous one ended (steps.length = return to home). */
  before: number;
  from: FacePt;
  to: FacePt;
}

export interface WalkResult {
  /** Starts at home. */
  path: PathPt[];
  gaps: Gap[];
  /** How many times each segment is cut. */
  segUse: number[];
}

/**
 * The kerf-offset contours split up per segment: `corners[k]` is the corner (arc points, or a
 * single miter point) at split k, from the side of the segment ending there to the side of
 * the one starting there; `bodies[g]` are the remaining stations of segment g.
 */
export interface OffsetLoop {
  corners: FacePt[][];
  bodies: FacePt[][];
}

/**
 * Split one contour's kerf stations (local segment numbers; an open contour's end station is
 * numbered one past its last segment) into corners and bodies.
 */
export function splitOffsetLoop(kerfStations: Station[], splits: number, segs = splits): OffsetLoop {
  const corners: FacePt[][] = Array.from({ length: splits }, () => []);
  const bodies: FacePt[][] = Array.from({ length: segs }, () => []);
  for (const s of kerfStations) (s.corner ? corners : bodies)[s.seg].push({ r: s.r, t: s.t });
  return { corners, bodies };
}

/** Contours' offset loops joined into one, in global split / segment order. */
export function joinOffsetLoops(loops: OffsetLoop[]): OffsetLoop {
  return { corners: loops.flatMap((l) => l.corners), bodies: loops.flatMap((l) => l.bodies) };
}

const GAP_TOL = 1e-6;
const same = (a: FacePt, b: FacePt) => dist(a.r, b.r) <= GAP_TOL && dist(a.t, b.t) <= GAP_TOL;

export function walkPlan(plan: CutPlan, loop: OffsetLoop, home: Vec2, topo?: Topo): WalkResult {
  const { corners, bodies } = loop;
  const t = asTopology(topo ?? bodies.length);
  const n = t.segs;
  const homePt: FacePt = { r: home, t: home };
  const segPath = (k: number, rev: boolean): FacePt[] => {
    const e = segSplits(t, k);
    const p = [corners[e.start][corners[e.start].length - 1], ...bodies[k], corners[e.end][0]];
    return rev ? p.reverse() : p;
  };
  const steps = plan.steps;
  const endsAtSplit = (s: PlanStep | undefined, k: number) => s?.kind === 'segment' && segEndSplit(s, t) === k;

  const resolve = (id: string, i: number, role: 'from' | 'to', cur: FacePt): FacePt => {
    const p: PlanPoint | undefined = plan.points[id];
    if (!p) throw new Error(`Plan step ${i + 1} refers to a missing point "${id}".`);
    switch (p.kind) {
      case 'home':
        return homePt;
      case 'free':
        return { r: p.p, t: p.p };
      case 'freePair':
        return { r: p.r, t: p.t };
      case 'level': {
        const c = corners[p.split];
        if (!c) throw new Error(`Plan step ${i + 1} refers to split ${p.split + 1}, which doesn't exist.`);
        const at = p.corner === 'last' ? c[c.length - 1] : c[0];
        return { r: { x: home.x, y: at.r.y }, t: { x: home.x, y: at.t.y } };
      }
      case 'split': {
        const c = corners[p.split];
        if (!c) throw new Error(`Plan step ${i + 1} refers to split ${p.split + 1}, which doesn't exist.`);
        if (role === 'from') return endsAtSplit(steps[i - 1], p.split) ? cur : c[0];
        // Entering a segment from a line: attach on the far side of the corner and arc into it.
        const next = steps[i + 1];
        if (next?.kind === 'segment' && next.reversed && segStartSplit(next, t) === p.split) return c[c.length - 1];
        return c[0];
      }
    }
  };

  const cornerOf = new Map<FacePt, number>();
  corners.forEach((c, k) => c.forEach((p) => cornerOf.set(p, k)));
  const path: PathPt[] = [{ ...homePt, speed: 'cut', step: -1, line: true, corner: -1 }];
  const gaps: Gap[] = [];
  const segUse = new Array<number>(n).fill(0);
  let cur = homePt;
  const push = (pts: FacePt[], speed: PathPt['speed'], step: number, line: boolean) => {
    for (const p of pts) path.push({ ...p, speed, step, line, corner: cornerOf.get(p) ?? -1 });
    if (pts.length) cur = pts[pts.length - 1];
  };
  const startAt = (start: FacePt, i: number) => {
    if (!same(cur, start)) {
      gaps.push({ before: i, from: cur, to: start });
      push([start], 'gap', i, true);
    }
  };

  steps.forEach((s, i) => {
    if (s.kind === 'segment') {
      if (s.seg < 0 || s.seg >= n) throw new Error(`Plan step ${i + 1} refers to segment ${s.seg + 1}, but the profiles have ${n}.`);
      segUse[s.seg]++;
      const body = segPath(s.seg, s.reversed);
      const prev = steps[i - 1];
      // Lead-in arc around the starting corner, unless we just came from somewhere else on the profile.
      const startSplit = segStartSplit(s, t);
      const cornerAtStart = s.reversed ? corners[startSplit].slice().reverse() : corners[startSplit];
      const fromAdjacent = prev?.kind === 'segment' && prev.reversed === s.reversed && segEndSplit(prev, t) === startSplit;
      const fromLine = !prev || prev.kind === 'line';
      if (fromAdjacent || fromLine) {
        startAt(cornerAtStart[0], i);
        push([...cornerAtStart.slice(1), ...body.slice(1)], 'cut', i, false);
      } else {
        startAt(body[0], i);
        push(body.slice(1), 'cut', i, false);
      }
    } else {
      const from = resolve(s.from, i, 'from', cur);
      const to = resolve(s.to, i, 'to', cur);
      startAt(from, i);
      push([to], s.speed, i, true);
    }
  });
  startAt(homePt, steps.length);
  return { path, gaps, segUse };
}
