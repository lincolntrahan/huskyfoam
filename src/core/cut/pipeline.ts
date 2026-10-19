import { applyAffine } from '../geom/affine';
import type { Profile } from '../geom/profile';
import { dist, lerp, type Vec2 } from '../geom/vec';
import { writeGcode, type CarriagePos, type Move } from '../gcode/writer';
import { contourOfSeg, makeTopology, type CutPlan, type Topology } from '../plan/model';
import { loopPlan, type ContourEntry, type Rect } from '../plan/templates';
import { joinOffsetLoops, splitOffsetLoop, walkPlan, type Gap, type OffsetLoop, type PathPt } from '../plan/walk';
import { arcLoop, nearestS, pointAtS, wrapS, type ArcLoop } from '../geom/arc';
import { isClosed } from '../geom/profile';
import { addSplit, setLoopStart } from '../sync/edit';
import { autoSync, segCount, syncStations, type SyncSettings } from '../sync/sync';
import { autoKerfSide, autoPairs, closestBetween, nearestSplit, offsetSide, type KerfSide } from './contours';
import type { OffsetSide } from './kerf';
import type { JobSettings, MachinePreset } from '../types';
import { findDwells } from './dwell';
import { offsetStations, type Station } from './kerf';
import { kerfAt } from './kerfTable';
import { applyToProfile, defaultTransforms, sideTransform, syncToRaw, syncToTransformed } from './transform';

/** The job step a problem belongs to (matches the app's pages; 'path' = the finished cut path). */
export type Stage = 'import' | 'setup' | 'transform' | 'segment' | 'sequence' | 'path';

export interface CutWarning {
  message: string;
  stage: Stage;
  /** Index into `moves` where the problem first appears, when it has a location. */
  moveIndex?: number;
  /** Plan step the problem belongs to, when it has one. */
  step?: number;
}

/** One contour pair as cut (transformed + positioned). */
export interface PairResult {
  /** Root and tip contour indices (into the loaded contour lists). */
  root: number;
  tip: number;
  closed: boolean;
  /** Splits are automatic (nothing stored for this pair). */
  auto: boolean;
  /** Sync as cut: positions on `arcs`. Edit it, then store it with `syncToJob`. */
  sync: SyncSettings;
  arcs: { root: ArcLoop; tip: ArcLoop };
  syncToJob: (s: SyncSettings) => SyncSettings;
  /** Contour outlines as cut (before kerf). */
  pts: { root: Vec2[]; tip: Vec2[] };
  /** Kerf side as set (maybe 'auto'), what 'auto' means here, and the offset direction used. */
  kerfSide: KerfSide;
  autoKerfSide: KerfSide;
  offset: OffsetSide;
  /** Stations before / after kerf, global segment numbers (closed contours repeat the first at the end). */
  stations: Station[];
  kerfStations: Station[];
  /** First global split and segment number of this pair. */
  split0: number;
  seg0: number;
}

export interface CutResult {
  ok: boolean;
  errors: string[];
  /** Step each error belongs to (same order as `errors`). */
  errorStages: Stage[];
  warnings: CutWarning[];
  /**
   * Sync as cut: positions on the transformed outlines (`arcs`), in the cut's loop order, so
   * index k is split k+1 on the canvas and in the plan. Edit this, then store it with `syncToJob`.
   */
  sync: SyncSettings | null;
  /** The cut outlines (transformed + positioned) as arc loops, for editing splits and pins. */
  arcs: { root: ArcLoop; tip: ArcLoop } | null;
  /** Convert an edited cut-space sync back to the form stored in job.sync (raw outlines). */
  syncToJob: ((s: SyncSettings) => SyncSettings) | null;
  /** Convert a cut-space arc position to a raw-outline one (for LE/TE overrides). */
  rawS: ((side: 'root' | 'tip', s: number) => number) | null;
  /** Positioned split points, in loop order (index = split number - 1). */
  splitPts: { root: Vec2[]; tip: Vec2[] };
  /** Positioned pin points, all pairs in order. */
  pinPts: { root: Vec2[]; tip: Vec2[] };
  /** Pair each pin belongs to. */
  pinPair: number[];
  /** Every contour pair being cut; pair 0 is the outer one (the fields above). */
  pairs: PairResult[];
  /** How splits and segments are numbered across the pairs. */
  topology: Topology | null;
  /** Where the default plan enters each other contour. */
  entries: ContourEntry[];
  /** Transformed + positioned outlines, as cut (before kerf). */
  profilePts: { root: Vec2[]; tip: Vec2[] };
  /** LE, TE and twist pivot of each profile, in machine face coordinates. */
  chord: { root: { le: Vec2; te: Vec2; pivot: Vec2 }; tip: { le: Vec2; te: Vec2; pivot: Vec2 } } | null;
  /** Synced face stations before kerf (closed: last equals first). */
  stations: Station[];
  /** Kerf-offset face stations (closed). */
  kerfStations: Station[];
  /** The plan that was walked (job.plan, or the default loop). */
  plan: CutPlan | null;
  /** Face path walked from the plan, starting at home. */
  path: PathPt[];
  gaps: Gap[];
  /** Carriage start (home) and every move after it. */
  start: CarriagePos;
  moves: Move[];
  gcode: string;
  stats: { cutMinutes: number; maxCarriageSpeed: number; segments: number; moves: number; dwells: number };
}

/** Linear map from the two face planes to the two carriage planes. */
/**
 * Where the root and tip profile planes sit along the wire. By default they are the block's
 * faces; with a profile distance and inset they sit inside (or past) the block.
 */
export function profilePlanes(job: JobSettings): { zr: number; zt: number; distance: number; inset: number } {
  const span = job.span;
  const distance = job.profile?.distance ?? span;
  const inset = job.profile?.inset ?? (span - distance) / 2;
  if (job.profile?.distance == null && job.profile?.inset == null) {
    // profiles on the block faces: keep the original arithmetic so output stays bit-identical
    const zr = job.rootSide === 'left' ? job.rootFaceFromLeft : job.rootFaceFromLeft + span;
    const zt = job.rootSide === 'left' ? job.rootFaceFromLeft + span : job.rootFaceFromLeft;
    return { zr, zt, distance, inset };
  }
  const zr = job.rootSide === 'left' ? job.rootFaceFromLeft + inset : job.rootFaceFromLeft + span - inset;
  const zt = job.rootSide === 'left' ? zr + distance : zr - distance;
  return { zr, zt, distance, inset };
}

export function projector(job: JobSettings, machine: MachinePreset) {
  const { zr, zt } = profilePlanes(job);
  const a = (0 - zr) / (zt - zr);
  const b = (machine.carriageSpacing - zr) / (zt - zr);
  return (r: Vec2, t: Vec2): CarriagePos => ({ left: lerp(r, t, a), right: lerp(r, t, b) });
}

function emptyResult(errors: string[], stage: Stage, warnings: CutWarning[] = []): CutResult {
  const z = { x: 0, y: 0 };
  return {
    ok: false,
    errors,
    errorStages: errors.map(() => stage),
    warnings,
    sync: null,
    arcs: null,
    syncToJob: null,
    rawS: null,
    splitPts: { root: [], tip: [] },
    pinPts: { root: [], tip: [] },
    pinPair: [],
    pairs: [],
    topology: null,
    entries: [],
    profilePts: { root: [], tip: [] },
    chord: null,
    stations: [],
    kerfStations: [],
    plan: null,
    path: [],
    gaps: [],
    start: { left: z, right: z },
    moves: [],
    gcode: '',
    stats: { cutMinutes: 0, maxCarriageSpeed: 0, segments: 0, moves: 0, dwells: 0 },
  };
}

const closeLoop = (s: Station[]) => (s.length ? [...s, { ...s[0], boundary: false }] : s);

const hasBlock = (b: Rect) => b.w > 0 && b.h > 0;

/** True when segment ab runs through the inside of the rectangle (touching the edge doesn't count). */
export function crossesRect(a: Vec2, b: Vec2, r: Rect): boolean {
  const eps = 1e-6;
  const x0 = r.x + eps;
  const x1 = r.x + r.w - eps;
  const y0 = r.y + eps;
  const y1 = r.y + r.h - eps;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    return t0 <= t1;
  };
  if (!(clip(-dx, a.x - x0) && clip(dx, x1 - a.x) && clip(-dy, a.y - y0) && clip(dy, y1 - a.y))) return false;
  return (t1 - t0) * Math.hypot(dx, dy) > eps;
}

const inside = (p: Vec2, r: Rect) => p.x > r.x + 1e-6 && p.x < r.x + r.w - 1e-6 && p.y > r.y + 1e-6 && p.y < r.y + r.h - 1e-6;

export function generateCut(rootIn: Profile | Profile[], tipIn: Profile | Profile[], job: JobSettings, machine: MachinePreset): CutResult {
  const errors: string[] = [];
  const warnings: CutWarning[] = [];
  const rootList = Array.isArray(rootIn) ? rootIn : [rootIn];
  const tipList = Array.isArray(tipIn) ? tipIn : [tipIn];

  if (job.span <= 0) return emptyResult(['Block span must be greater than zero.'], 'setup');
  const planes = profilePlanes(job);
  if (!(planes.distance > 0)) return emptyResult(['Profile distance must be greater than zero.'], 'transform');
  if (job.cutSpeed <= 0) return emptyResult(['Cut speed must be greater than zero.'], 'setup');
  if (!rootList.length || !tipList.length) return emptyResult(['Both profiles need at least one contour.'], 'import');

  if (planes.inset < -1e-9 || planes.inset + planes.distance > job.span + 1e-9) {
    warnings.push({ stage: 'transform', message: 'The profiles sit outside the foam block along the wire (check profile distance and inset against the block span).' });
  }
  const T = job.transforms ?? defaultTransforms();
  if (!(T.root.scale > 0 && T.tip.scale > 0)) return emptyResult(['Scale must be greater than zero.'], 'transform');

  // 1. Transform each profile (twist / scale / flip / move about its pivot, then the part offset).
  //    The outer contour (0) sets the chord and pivot; every contour of that side moves with it.
  const rootIn0 = rootList[0];
  const tipIn0 = tipList[0];
  const raw = { root: arcLoop(rootIn0), tip: arcLoop(tipIn0) };
  const st = {
    root: sideTransform(rootIn0, raw.root, T.root, T.flipH, T.flipV, job.offset),
    tip: sideTransform(tipIn0, raw.tip, T.tip, T.flipH, T.flipV, job.offset),
  };
  const root = applyToProfile(rootIn0, st.root);
  const tip = applyToProfile(tipIn0, st.tip);
  const profilePts = { root: root.pts, tip: tip.pts };
  const chordOf = (k: 'root' | 'tip') => {
    const c = st[k].chord;
    return { le: applyAffine(st[k].affine, c.le), te: applyAffine(st[k].affine, c.te), pivot: applyAffine(st[k].affine, c.pivot) };
  };
  const chord = { root: chordOf('root'), tip: chordOf('tip') };

  // 2. Pair the contours: the outer ones always, the rest by position (or as the user paired them).
  const C = job.contours ?? { pairs: null, sync: {}, kerfSide: {} };
  const want = C.pairs && C.pairs.length === rootList.length ? C.pairs : autoPairs(rootList, tipList);
  const used = new Set<number>([0]);
  const pairList: { r: number; t: number }[] = [{ r: 0, t: 0 }];
  for (let r = 1; r < rootList.length; r++) {
    const t = want[r];
    if (t == null || t < 1 || t >= tipList.length || used.has(t)) {
      warnings.push({ stage: 'segment', message: `Root contour ${r + 1} has no tip contour to pair with, so it is not cut.` });
      continue;
    }
    used.add(t);
    pairList.push({ r, t });
  }
  for (let t = 1; t < tipList.length; t++) {
    if (!used.has(t)) warnings.push({ stage: 'segment', message: `Tip contour ${t + 1} has no root contour to pair with, so it is not cut.` });
  }

  // 3. Splits (sync points) per pair. Stored syncs are on the raw contours; auto sync is found on the cut shape.
  const rawS = (side: 'root' | 'tip', x: number) => {
    const one = syncToRaw({ root: [x], tip: [x], pins: [] }, st, raw);
    return one[side][0];
  };
  const pairs: PairResult[] = pairList.map(({ r, t }, p) => {
    const rawA = p === 0 ? raw : { root: arcLoop(rootList[r]), tip: arcLoop(tipList[t]) };
    const cut = p === 0 ? { root, tip } : { root: applyToProfile(rootList[r], st.root), tip: applyToProfile(tipList[t], st.tip) };
    const arcs = { root: arcLoop(cut.root), tip: arcLoop(cut.tip) };
    const stored = p === 0 ? job.sync : C.sync[r];
    const sync = stored ? syncToTransformed(stored, st, rawA) : autoSync(cut.root, cut.tip, job.cornerSplitDeg);
    const closed = isClosed(cut.root);
    const chosen = C.kerfSide[r] ?? 'auto';
    const autoSide = autoKerfSide(cut.root, root, p === 0);
    return {
      root: r,
      tip: t,
      closed,
      auto: !stored,
      sync,
      arcs,
      syncToJob: (x: SyncSettings) => syncToRaw(x, st, rawA),
      pts: { root: cut.root.pts, tip: cut.tip.pts },
      kerfSide: chosen,
      autoKerfSide: autoSide,
      offset: offsetSide(chosen, cut.root, root, p === 0),
      stations: [],
      kerfStations: [],
      split0: 0,
      seg0: 0,
    };
  });
  for (const pr of pairs.slice(1)) {
    if (pr.closed !== isClosed(tipList[pr.tip])) {
      const res = emptyResult([`Root contour ${pr.root + 1} and tip contour ${pr.tip + 1} can't be cut together: one is closed and the other is open. Pair them differently.`], 'segment', warnings);
      return Object.assign(res, { pairs, profilePts, chord, rawS });
    }
  }

  // Default entries: leave the outer contour where it comes closest to each other contour.
  const outer = pairs[0];
  for (const pr of pairs.slice(1)) {
    const near = closestBetween(outer.arcs.root, pr.arcs.root);
    if (outer.auto) {
      const ed = addSplit(outer.sync, null, outer.arcs, 'root', near.sa);
      if (ed) outer.sync = ed.sync;
    }
    if (pr.auto && pr.closed) {
      // start the contour at the point nearest the outer contour
      const sIn = nearestS(pr.arcs.root, pointAtS(outer.arcs.root, near.sa)).s;
      let k = pr.sync.root.findIndex((x) => Math.abs(x - sIn) < 1e-6);
      if (k < 0) {
        const ed = addSplit(pr.sync, null, pr.arcs, 'root', sIn);
        if (ed) {
          pr.sync = ed.sync;
          k = pr.sync.root.findIndex((x) => Math.abs(x - wrapS(pr.arcs.root, sIn)) < 1e-9);
        }
      }
      if (k > 0) pr.sync = setLoopStart(pr.sync, null, k).sync;
    }
  }
  const syncT = outer.sync;
  const syncToJob = outer.syncToJob;
  const rootArc = outer.arcs.root;
  const tipArc = outer.arcs.tip;

  const splitPts = {
    root: pairs.flatMap((pr) => pr.sync.root.map((s) => pointAtS(pr.arcs.root, s))),
    tip: pairs.flatMap((pr) => pr.sync.tip.map((s) => pointAtS(pr.arcs.tip, s))),
  };
  const pinPts = {
    root: pairs.flatMap((pr) => pr.sync.pins.map((x) => pointAtS(pr.arcs.root, x.root))),
    tip: pairs.flatMap((pr) => pr.sync.pins.map((x) => pointAtS(pr.arcs.tip, x.tip))),
  };
  const pinPair = pairs.flatMap((pr, p) => pr.sync.pins.map(() => p));
  const extra = { sync: syncT, arcs: { root: rootArc, tip: tipArc }, syncToJob, rawS, splitPts, pinPts, pinPair, profilePts, chord, pairs };
  for (const [p, pr] of pairs.entries()) {
    if (pr.sync.root.length !== pr.sync.tip.length) {
      const what = pairs.length > 1 ? `Contour pair ${p + 1}: root` : 'Root';
      return Object.assign(
        emptyResult([
          `${what} has ${segCount(pr.arcs.root, pr.sync.root.length)} segments but tip has ${segCount(pr.arcs.tip, pr.sync.tip.length)}. Each root segment must pair with a tip segment; make the two profiles from the same entities, adjust the corner threshold, or add/remove splits.`,
        ], 'segment', warnings),
        extra,
      );
    }
    if (!pr.closed && pr.sync.root.length < 2) {
      return Object.assign(emptyResult([`Contour pair ${p + 1} is open but has fewer than 2 splits.`], 'segment', warnings), extra);
    }
  }
  const topology = makeTopology(pairs.map((pr) => ({ closed: pr.closed, splits: pr.sync.root.length })));
  pairs.forEach((pr, p) => {
    pr.split0 = topology.contours[p].split0;
    pr.seg0 = topology.contours[p].seg0;
  });
  const n = topology.segs;
  // where the default plan enters each other contour: the outer split nearest its first split
  const outerSplits = splitPts.root.slice(0, outer.sync.root.length);
  const entries: ContourEntry[] = pairs.slice(1).map((pr, i) => ({ outer: nearestSplit(outerSplits, splitPts.root[pr.split0]), contour: i + 1 }));

  // 4. Resample each matched pair (and pin spans) to equal counts, then kerf. Segment overrides
  //    win; otherwise fixed per face, or from the material's kerf table at the speed each face
  //    actually moves at that point.
  const over = job.segmentOverrides ?? {};
  const segSpeed = (seg: number) => over[seg]?.speed ?? job.cutSpeed;
  const auto = job.kerf.mode === 'auto';
  if (auto && !job.kerfTable?.length) {
    warnings.push({ stage: 'setup', message: 'Auto kerf needs a kerf table in the material (use the kerf test). Using the fixed root/tip kerf instead.' });
  }
  let clamped = 0;
  const loops: OffsetLoop[] = pairs.map((pr) => {
    const synced = syncStations(pr.arcs.root, pr.arcs.tip, pr.sync, job.sampling);
    warnings.push(...synced.warnings.map((message) => ({ message: pairs.length > 1 ? `Contour pair ${pairs.indexOf(pr) + 1}: ${message}` : message, stage: 'segment' as const })));
    const local: Station[] = synced.stations;
    const segs = topology.contours[pairs.indexOf(pr)].segs;
    // global segment of a local one (an open contour's end station belongs to its last segment)
    const gSeg = (seg: number) => pr.seg0 + Math.min(seg, Math.max(segs - 1, 0));
    let kerfFor = (side: 'root' | 'tip') => (_i: number, seg: number) => over[gSeg(seg)]?.kerf ?? job.kerf[side];
    if (auto && job.kerfTable?.length) {
      const faceKerf = (side: 'root' | 'tip') =>
        local.map((s, i) => {
          const next = local[(i + 1) % local.length];
          const dr = dist(s.r, next.r);
          const dt = dist(s.t, next.t);
          const m = Math.max(dr, dt);
          // the faster face moves at the segment's cut speed; the other in proportion
          const v = m > 0 ? (segSpeed(gSeg(s.seg)) * (side === 'root' ? dr : dt)) / m : segSpeed(gSeg(s.seg));
          const k = kerfAt(job.kerfTable, v);
          if (k.clamped) clamped++;
          return k.kerf;
        });
      const table = { root: faceKerf('root'), tip: faceKerf('tip') };
      kerfFor = (side) => (i, seg) => over[gSeg(seg)]?.kerf ?? table[side][i];
    }
    const kerfLocal = offsetStations(local, kerfFor('root'), kerfFor('tip'), { open: !pr.closed, side: pr.offset });
    const globalSeg = (s: Station): Station => ({ ...s, seg: gSeg(s.seg) });
    pr.stations = pr.closed ? closeLoop(local).map(globalSeg) : local.map(globalSeg);
    pr.kerfStations = pr.closed ? closeLoop(kerfLocal).map(globalSeg) : kerfLocal.map(globalSeg);
    return splitOffsetLoop(kerfLocal, pr.sync.root.length, segs);
  });
  if (clamped) {
    warnings.push({ stage: 'setup', message: `${clamped} point${clamped === 1 ? ' moves' : 's move'} faster or slower than the kerf table covers; the nearest table kerf was used.` });
  }
  const stations = outer.stations;
  const kerfStations = outer.kerfStations;

  // 5. Walk the cut plan
  const plan = job.plan ?? loopPlan(topology, false, entries);
  const home = machine.home;
  const pathExtra = { ...extra, topology, entries, stations, kerfStations, plan };
  let walk;
  try {
    walk = walkPlan(plan, joinOffsetLoops(loops), home, topology);
  } catch (e) {
    const res = emptyResult([`${(e as Error).message} Reset the plan with a template.`], 'sequence', warnings);
    return Object.assign(res, pathExtra);
  }
  for (const g of walk.gaps) {
    errors.push(
      g.before >= plan.steps.length
        ? 'The plan does not end at home. Add a line back to home (or use "Bridge").'
        : `Gap before step ${g.before + 1}: it doesn't start where step ${g.before} ends. Bridge it with a jog or cut, or reorder the steps.`,
    );
  }
  walk.segUse.forEach((count, k) => {
    // an open contour is normally cut there and back
    const open = !topology.contours[contourOfSeg(topology, k)]?.closed;
    if (count === 0) warnings.push({ stage: 'sequence', message: `Segment ${k + 1} is never cut.` });
    if (count > (open ? 2 : 1)) warnings.push({ stage: 'sequence', message: `Segment ${k + 1} is cut ${count} times.` });
  });

  // 6. Project and time each move
  const project = projector(job, machine);
  const start = project(home, home);
  const moves: Move[] = [];
  let prevFace: PathPt = walk.path[0];
  let prevCar = start;
  let cutMinutes = 0;
  let maxCarriageSpeed = 0;
  let capped = 0;
  let firstCapped = -1;
  const jogHits = new Set<number>();
  /** Index of the last move emitted up to each path point (for placing dwells). */
  const moveAt: number[] = [-1];
  const stepSpeed = (step: number) => {
    const st = plan.steps[step];
    return st?.kind === 'segment' ? segSpeed(st.seg) : job.cutSpeed;
  };
  for (const p of walk.path.slice(1)) {
    moveAt.push(moves.length - 1);
    if (p.speed === 'gap') {
      prevFace = p;
      prevCar = project(p.r, p.t);
      continue;
    }
    const dFace = Math.max(dist(p.r, prevFace.r), dist(p.t, prevFace.t));
    const car = project(p.r, p.t);
    const dCar = Math.max(dist(car.left, prevCar.left), dist(car.right, prevCar.right));
    if (dFace < 1e-9 && dCar < 1e-9) continue;
    if (p.speed === 'jog' && hasBlock(job.block) && (crossesRect(prevFace.r, p.r, job.block) || crossesRect(prevFace.t, p.t, job.block))) {
      jogHits.add(p.step);
    }
    let minutes = p.speed === 'jog' ? dCar / machine.jogSpeed : dFace / stepSpeed(p.step);
    const speed = minutes > 0 ? dCar / minutes : Infinity;
    maxCarriageSpeed = Math.max(maxCarriageSpeed, speed);
    if (speed > machine.maxSpeed) {
      capped++;
      if (firstCapped < 0) firstCapped = moves.length;
      minutes = dCar / machine.maxSpeed;
    }
    moves.push({ left: car.left, right: car.right, minutes, lead: p.line, speed: p.speed, step: p.step });
    cutMinutes += minutes;
    moveAt[moveAt.length - 1] = moves.length - 1;
    prevFace = p;
    prevCar = car;
  }

  // 7. Corner dwell
  let dwells = 0;
  if (job.dwell?.enabled && job.dwell.seconds > 0) {
    for (const j of findDwells(walk.path, job.dwell.angleDeg)) {
      const mi = moveAt[j];
      if (mi < 0 || moves[mi].dwell) continue;
      moves[mi].dwell = job.dwell.seconds;
      cutMinutes += job.dwell.seconds / 60;
      dwells++;
    }
  }
  if (capped) {
    warnings.push({
      stage: 'path',
      message: `${capped} move${capped === 1 ? '' : 's'} would drive a carriage at up to ${maxCarriageSpeed.toFixed(2)} ${machine.units}/min, over the machine cap of ${machine.maxSpeed}. Those moves are slowed to the cap in the G-code.`,
      moveIndex: firstCapped,
    });
  }
  for (const s of jogHits) {
    warnings.push({ stage: 'sequence', message: `Step ${s + 1} is a jog through the foam block; it would cut at jog speed. Make it a cut or route it around the block.`, step: s });
  }

  // 6. Cut lines that stop inside the block
  if (hasBlock(job.block)) {
    plan.steps.forEach((s, i) => {
      if (s.kind !== 'line' || s.speed !== 'cut') return;
      for (const id of [s.from, s.to]) {
        const pt = plan.points[id];
        const pts = pt?.kind === 'free' ? [pt.p] : pt?.kind === 'freePair' ? [pt.r, pt.t] : [];
        if (pts.some((q) => inside(q, job.block))) {
          warnings.push({ stage: 'sequence', message: `Step ${i + 1} ends inside the foam block; the wire would stop in the foam.`, step: i });
          break;
        }
      }
    });
  }

  // 7. Travel limits
  const [x0, x1] = machine.travel.x;
  const [y0, y1] = machine.travel.y;
  const outside = (p: Vec2) => p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1;
  const firstOut = moves.findIndex((m) => outside(m.left) || outside(m.right));
  if (firstOut >= 0) {
    const count = moves.filter((m) => outside(m.left) || outside(m.right)).length;
    warnings.push({ stage: 'path', message: `${count} move${count === 1 ? ' goes' : 's go'} outside the machine travel limits.`, moveIndex: firstOut });
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    errorStages: errors.map(() => 'sequence' as const),
    warnings,
    ...pathExtra,
    path: walk.path,
    gaps: walk.gaps,
    start,
    moves,
    gcode: ok ? writeGcode(start, moves, machine, job.cutSpeed, { wireWatts: job.wireWatts }) : '',
    stats: { cutMinutes, maxCarriageSpeed, segments: n, moves: moves.length, dwells },
  };
}
