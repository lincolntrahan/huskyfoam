import type { Vec2 } from './geom/vec';

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
  /** Straight-wire waypoints between home and the loop start (lead-out runs them in reverse). */
  leadIn: Vec2[];
}
