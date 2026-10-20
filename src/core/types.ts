import type { Vec2 } from './geom/vec';
import type { CutPlan } from './plan/model';
import type { SyncSettings } from './sync/sync';
import type { Transforms } from './cut/transform';
import type { KerfSide } from './cut/contours';
import type { Layout } from './cut/placement';

export type Units = 'in' | 'mm';

export interface AxisLetters {
  leftH: string;
  leftV: string;
  rightH: string;
  rightV: string;
}

export interface MachinePreset {
  id: string;
  name: string;
  units: Units;
  /** Distance between the left and right carriage planes (along the wire). */
  carriageSpacing: number;
  /** Travel limits, same for both carriages. */
  travel: { x: [number, number]; y: [number, number] };
  /** Per-carriage speed cap, units/min. Exceeding it warns, and export stretches the move. */
  maxSpeed: number;
  /** Speed of jog lines (coordinated G1, measured on the faster carriage), units/min. */
  jogSpeed: number;
  /** Home position; both carriages go here, so the wire is straight. */
  home: Vec2;
  axes: AxisLetters;
  /** Order the four axis words appear on each line, e.g. ["leftH","leftV","rightH","rightV"]. */
  axisOrder: (keyof AxisLetters)[];
  feedMode: 'G93' | 'G94';
  decimals: number;
  /** Header template. Tokens: {units} -> G20/G21, {cutSpeed}. */
  header: string;
  footer: string;
  /** How the controller reads G4 P: seconds (Mach3 default) or milliseconds. */
  dwellUnits?: 's' | 'ms';
}

/** One measured point of kerf vs. wire speed (speed at that foam face, units/min). */
export interface KerfPoint {
  speed: number;
  kerf: number;
}

export interface DwellSettings {
  enabled: boolean;
  /** Pause at corners where the cut path turns more than this. */
  angleDeg: number;
  seconds: number;
}

export interface MaterialPreset {
  id: string;
  name: string;
  units: Units;
  /** Wire speed at the faster foam face, units/min. */
  cutSpeed: number;
  kerfRoot: number;
  kerfTip: number;
  /** Fixed root/tip kerf, or per-point kerf from the table below. */
  kerfMode?: 'fixed' | 'auto';
  /** Optional kerf-vs-speed table for "auto from speed" kerf (fill it with the kerf test). */
  kerfTable?: KerfPoint[];
  /** Default corner dwell for this material (contact cutting needs it; radiant usually not). */
  cornerDwell?: DwellSettings;
  /** Hot-wire power to set on the cutter's supply, watts. Written as a comment and {wireWatts}. */
  wireWatts?: number;
  /**
   * Slowest a foam face should be cut, units/min: below it the cut gets wide and hourglassed.
   * Only warns. Missing = no limit.
   */
  minSpeed?: number;
}

/** Per-segment overrides (both faces), keyed by segment index in cut order. */
export interface SegmentOverride {
  kerf?: number;
  /** Cut speed at the faster face for this segment, units/min. */
  speed?: number;
}

export interface SamplingSettings {
  mode: 'adaptive' | 'uniform';
  /** Uniform: station spacing on the longer side. */
  step: number;
  /** Adaptive: max deviation from the true curve. */
  tolerance: number;
  /** Adaptive: never leave a gap bigger than this on the longer side. */
  maxStep: number;
}

export interface JobSettings {
  /** DXF entities used for each profile (indices into the file); null = automatic pick. */
  selection: { root: number[] | null; tip: number[] | null };
  /** Each DXF is rotated by this many degrees (0, 90, 180, 270; CCW) on import, to match the cutter's axes. */
  rotation: { root: number; tip: number };
  /**
   * How the part sits on the machine: profile position along the wire, floor offset, block size
   * and alignment. The fields below it (rootFaceFromLeft, span, profile.inset, offset, block)
   * are then worked out from it by placeJob. null = set those fields by hand (tests, old code).
   */
  layout: Layout | null;
  /** Distance from the left carriage plane to the block's left face. */
  rootFaceFromLeft: number;
  /** Block span (root face to tip face). */
  span: number;
  /**
   * Profile planes inside the block: distance between the root and tip profiles (null = the
   * block span) and the root profile's inset from the block's root face (null = centered).
   */
  profile: { distance: number | null; inset: number | null };
  rootSide: 'left' | 'right';
  /** Translation applied to both profiles (positions the part in machine XY). */
  offset: Vec2;
  /**
   * Full kerf width at each face; the path is offset by half of it. In 'auto' mode the kerf
   * at every point comes from `kerfTable` and how fast that face is moving there.
   */
  kerf: { mode: 'fixed' | 'auto'; root: number; tip: number };
  /** Kerf vs. speed, copied from the material when it's selected. */
  kerfTable: KerfPoint[];
  /** Per-segment kerf / speed overrides (both faces), by segment index. */
  segmentOverrides: Record<number, SegmentOverride>;
  /** Pause at sharp corners so the wire catches up. */
  dwell: DwellSettings;
  /** Hot-wire power for this job, watts (from the material); null = not specified. */
  wireWatts: number | null;
  /** Slowest face speed before the cut gets poor, from the material (warning only); null = none. */
  minSpeed: number | null;
  /** Cut speed at the faster face, units/min. */
  cutSpeed: number;
  sampling: SamplingSettings;
  /** Corners sharper than this become automatic split points. */
  cornerSplitDeg: number;
  /** Foam block outline on the faces (same on both). w or h of 0 means "not set": no block checks. */
  block: { x: number; y: number; w: number; h: number };
  /** Twist / scale / move / flip per profile. */
  transforms: Transforms;
  /** Split and pin positions on the raw outlines; null = automatic (entity boundaries + sharp corners). */
  sync: SyncSettings | null;
  /**
   * Profiles with several contours (spar holes, open cuts). Contour 0 is the outer one; its
   * sync is `sync` above. Everything here is keyed by root contour index.
   */
  contours: {
    /** Tip contour each root contour is cut with (-1 = not cut); null = automatic by position. */
    pairs: number[] | null;
    /** Sync of the other pairs, on the raw contours; missing = automatic. */
    sync: Record<number, SyncSettings>;
    /** Kerf side per pair; missing = automatic. */
    kerfSide: Record<number, KerfSide>;
  };
  /**
   * Cut plan. New jobs start with an empty plan; null (projects from before sequencing folders)
   * = the old default: one loop round the outline, entering each other contour from it.
   */
  plan: CutPlan | null;
  /** How far above the block (or the profiles, with no block) jogs over the block travel. */
  jogClearance: number;
}
