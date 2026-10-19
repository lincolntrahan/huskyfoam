import type { Vec2 } from './geom/vec';
import type { CutPlan } from './plan/model';
import type { SyncSettings } from './sync/sync';
import type { Transforms } from './cut/transform';

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
}

export interface MaterialPreset {
  id: string;
  name: string;
  units: Units;
  /** Wire speed at the faster foam face, units/min. */
  cutSpeed: number;
  kerfRoot: number;
  kerfTip: number;
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
  /** Distance from the left carriage plane to the root face. */
  rootFaceFromLeft: number;
  /** Block span (root face to tip face). */
  span: number;
  rootSide: 'left' | 'right';
  /** Translation applied to both profiles (positions the part in machine XY). */
  offset: Vec2;
  /** Full kerf width at each face; the path is offset by half of it. */
  kerf: { root: number; tip: number };
  /** Per-segment kerf override (both faces), by segment index. */
  segmentKerf: Record<number, number>;
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
  /** Cut plan; null = the default Loop template for however many segments the profiles have. */
  plan: CutPlan | null;
}
