import { applyAffine } from '../geom/affine';
import type { Profile } from '../geom/profile';
import { dist, lerp, type Vec2 } from '../geom/vec';
import { writeGcode, type CarriagePos, type Move } from '../gcode/writer';
import type { CutPlan } from '../plan/model';
import { loopPlan, type Rect } from '../plan/templates';
import { splitOffsetLoop, walkPlan, type Gap, type PathPt } from '../plan/walk';
import { arcLoop, pointAtS, type ArcLoop } from '../geom/arc';
import { autoSync, syncStations, type SyncSettings } from '../sync/sync';
import type { JobSettings, MachinePreset } from '../types';
import { offsetStations, type Station } from './kerf';
import { applyToProfile, defaultTransforms, sideTransform, syncToRaw, syncToTransformed } from './transform';

export interface CutWarning {
  message: string;
  /** Index into `moves` where the problem first appears, when it has a location. */
  moveIndex?: number;
  /** Plan step the problem belongs to, when it has one. */
  step?: number;
}

export interface CutResult {
  ok: boolean;
  errors: string[];
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
  /** Positioned pin points. */
  pinPts: { root: Vec2[]; tip: Vec2[] };
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
  stats: { cutMinutes: number; maxCarriageSpeed: number; segments: number; moves: number };
}

/** Linear map from the two face planes to the two carriage planes. */
export function projector(job: JobSettings, machine: MachinePreset) {
  const zr = job.rootSide === 'left' ? job.rootFaceFromLeft : job.rootFaceFromLeft + job.span;
  const zt = job.rootSide === 'left' ? job.rootFaceFromLeft + job.span : job.rootFaceFromLeft;
  const a = (0 - zr) / (zt - zr);
  const b = (machine.carriageSpacing - zr) / (zt - zr);
  return (r: Vec2, t: Vec2): CarriagePos => ({ left: lerp(r, t, a), right: lerp(r, t, b) });
}

function emptyResult(errors: string[], warnings: CutWarning[] = []): CutResult {
  const z = { x: 0, y: 0 };
  return {
    ok: false,
    errors,
    warnings,
    sync: null,
    arcs: null,
    syncToJob: null,
    rawS: null,
    splitPts: { root: [], tip: [] },
    pinPts: { root: [], tip: [] },
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
    stats: { cutMinutes: 0, maxCarriageSpeed: 0, segments: 0, moves: 0 },
  };
}

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

export function generateCut(rootIn: Profile, tipIn: Profile, job: JobSettings, machine: MachinePreset): CutResult {
  const errors: string[] = [];
  const warnings: CutWarning[] = [];

  if (job.span <= 0) return emptyResult(['Block span must be greater than zero.']);
  if (job.cutSpeed <= 0) return emptyResult(['Cut speed must be greater than zero.']);

  const T = job.transforms ?? defaultTransforms();
  if (!(T.root.scale > 0 && T.tip.scale > 0)) return emptyResult(['Scale must be greater than zero.']);

  // 1. Transform each profile (twist / scale / flip / move about its pivot, then the part offset)
  const raw = { root: arcLoop(rootIn), tip: arcLoop(tipIn) };
  const st = {
    root: sideTransform(rootIn, raw.root, T.root, T.flipH, T.flipV, job.offset),
    tip: sideTransform(tipIn, raw.tip, T.tip, T.flipH, T.flipV, job.offset),
  };
  const root = applyToProfile(rootIn, st.root);
  const tip = applyToProfile(tipIn, st.tip);
  const profilePts = { root: root.pts, tip: tip.pts };
  const chordOf = (k: 'root' | 'tip') => {
    const c = st[k].chord;
    return { le: applyAffine(st[k].affine, c.le), te: applyAffine(st[k].affine, c.te), pivot: applyAffine(st[k].affine, c.pivot) };
  };
  const chord = { root: chordOf('root'), tip: chordOf('tip') };

  // 2. Splits (sync points). job.sync is stored on the raw outlines; auto sync is found on the cut shape.
  const rootArc = arcLoop(root);
  const tipArc = arcLoop(tip);
  const syncT = job.sync ? syncToTransformed(job.sync, st, raw) : autoSync(root, tip, job.cornerSplitDeg);
  const syncToJob = (x: SyncSettings) => syncToRaw(x, st, raw);
  const rawS = (side: 'root' | 'tip', x: number) => {
    const one = syncToRaw({ root: [x], tip: [x], pins: [] }, st, raw);
    return one[side][0];
  };
  const splitPts = { root: syncT.root.map((s) => pointAtS(rootArc, s)), tip: syncT.tip.map((s) => pointAtS(tipArc, s)) };
  const pinPts = { root: syncT.pins.map((p) => pointAtS(rootArc, p.root)), tip: syncT.pins.map((p) => pointAtS(tipArc, p.tip)) };
  const extra = { sync: syncT, arcs: { root: rootArc, tip: tipArc }, syncToJob, rawS, splitPts, pinPts, profilePts, chord };
  if (syncT.root.length !== syncT.tip.length) {
    return Object.assign(
      emptyResult([
        `Root has ${syncT.root.length} segments but tip has ${syncT.tip.length}. Each root segment must pair with a tip segment; make the two profiles from the same entities, adjust the corner threshold, or add/remove splits.`,
      ]),
      extra,
    );
  }
  const n = syncT.root.length;

  // 3. Resample each matched pair (and pin spans) to equal counts
  const synced = syncStations(rootArc, tipArc, syncT, job.sampling);
  const stations: Station[] = synced.stations;
  warnings.push(...synced.warnings.map((message) => ({ message })));

  // 3. Kerf, on the full closed loop
  const kerfFor = (side: 'root' | 'tip') => (seg: number) => job.segmentKerf[seg] ?? job.kerf[side];
  const kerfStations = offsetStations(stations, kerfFor('root'), kerfFor('tip'));
  const closeLoop = (s: Station[]) => [...s, { ...s[0], boundary: false }];

  // 4. Walk the cut plan
  const plan = job.plan ?? loopPlan(n);
  const home = machine.home;
  let walk;
  try {
    walk = walkPlan(plan, splitOffsetLoop(kerfStations, n), home);
  } catch (e) {
    const res = emptyResult([`${(e as Error).message} Reset the plan with a template.`]);
    Object.assign(res, { ...extra, stations: closeLoop(stations), kerfStations: closeLoop(kerfStations), plan });
    return res;
  }
  for (const g of walk.gaps) {
    errors.push(
      g.before >= plan.steps.length
        ? 'The plan does not end at home. Add a line back to home (or use "Bridge").'
        : `Gap before step ${g.before + 1}: it doesn't start where step ${g.before} ends. Bridge it with a jog or cut, or reorder the steps.`,
    );
  }
  walk.segUse.forEach((count, k) => {
    if (count === 0) warnings.push({ message: `Segment ${k + 1} is never cut.` });
    if (count > 1) warnings.push({ message: `Segment ${k + 1} is cut ${count} times.` });
  });

  // 5. Project and time each move
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
  for (const p of walk.path.slice(1)) {
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
    let minutes = p.speed === 'jog' ? dCar / machine.jogSpeed : dFace / job.cutSpeed;
    const speed = minutes > 0 ? dCar / minutes : Infinity;
    maxCarriageSpeed = Math.max(maxCarriageSpeed, speed);
    if (speed > machine.maxSpeed) {
      capped++;
      if (firstCapped < 0) firstCapped = moves.length;
      minutes = dCar / machine.maxSpeed;
    }
    moves.push({ left: car.left, right: car.right, minutes, lead: p.line, speed: p.speed, step: p.step });
    cutMinutes += minutes;
    prevFace = p;
    prevCar = car;
  }
  if (capped) {
    warnings.push({
      message: `${capped} move${capped === 1 ? '' : 's'} would drive a carriage at up to ${maxCarriageSpeed.toFixed(2)} ${machine.units}/min, over the machine cap of ${machine.maxSpeed}. Those moves are slowed to the cap in the G-code.`,
      moveIndex: firstCapped,
    });
  }
  for (const s of jogHits) {
    warnings.push({ message: `Step ${s + 1} is a jog through the foam block; it would cut at jog speed. Make it a cut or route it around the block.`, step: s });
  }

  // 6. Cut lines that stop inside the block
  if (hasBlock(job.block)) {
    plan.steps.forEach((s, i) => {
      if (s.kind !== 'line' || s.speed !== 'cut') return;
      for (const id of [s.from, s.to]) {
        const pt = plan.points[id];
        const pts = pt?.kind === 'free' ? [pt.p] : pt?.kind === 'freePair' ? [pt.r, pt.t] : [];
        if (pts.some((q) => inside(q, job.block))) {
          warnings.push({ message: `Step ${i + 1} ends inside the foam block; the wire would stop in the foam.`, step: i });
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
    warnings.push({ message: `${count} move${count === 1 ? ' goes' : 's go'} outside the machine travel limits.`, moveIndex: firstOut });
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    ...extra,
    stations: closeLoop(stations),
    kerfStations: closeLoop(kerfStations),
    plan,
    path: walk.path,
    gaps: walk.gaps,
    start,
    moves,
    gcode: ok ? writeGcode(start, moves, machine, job.cutSpeed) : '',
    stats: { cutMinutes, maxCarriageSpeed, segments: n, moves: moves.length },
  };
}
