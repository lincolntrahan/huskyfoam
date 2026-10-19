import type { Vec2 } from '../geom/vec';
import { writeGcode, type Move } from '../gcode/writer';
import type { KerfPoint, MachinePreset, MaterialPreset } from '../types';

export interface KerfTestSpec {
  /** Side of each square plug, as cut (no kerf offset). */
  nominal: number;
  /** Speeds to test, as fractions of the material's cut speed. */
  fractions: number[];
  /** Bottom-left corner of the foam block (machine XY). */
  blockX: number;
  blockY: number;
  /** Gap between plugs, from the block's left edge, and how far below the block the wire travels. */
  gap: number;
  /** Height of the plugs' bottom edge above the block's bottom. */
  lift: number;
}

export const defaultKerfTest = (units: 'in' | 'mm'): KerfTestSpec =>
  units === 'in'
    ? { nominal: 1, fractions: [0.4, 0.6, 0.8, 1], blockX: 2, blockY: 0.5, gap: 0.5, lift: 0.5 }
    : { nominal: 25, fractions: [0.4, 0.6, 0.8, 1], blockX: 50, blockY: 12, gap: 12, lift: 12 };

export interface KerfTestPlug {
  /** Plug number, left to right (1-based). */
  n: number;
  /** Face speed it was cut at, units/min. */
  speed: number;
  /** Bottom-left corner of the plug. */
  at: Vec2;
}

/**
 * Straight-wire G-code that cuts one square plug per speed, left to right. The wire enters
 * from below the block, cuts the square at the plug's speed, leaves the way it came, and jogs
 * along under the block to the next plug. Measure each plug: kerf = nominal - measured size.
 */
export function kerfTestGcode(spec: KerfTestSpec, machine: MachinePreset, material: MaterialPreset): { gcode: string; plugs: KerfTestPlug[] } {
  const N = spec.nominal;
  const below = spec.blockY - spec.gap;
  const moves: Move[] = [];
  let at: Vec2 = machine.home;
  const go = (p: Vec2, speed: number, kind: 'cut' | 'jog') => {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d < 1e-12) return;
    const v = Math.min(speed, machine.maxSpeed);
    moves.push({ left: p, right: p, minutes: d / v, lead: kind === 'jog', speed: kind });
    at = p;
  };
  const plugs: KerfTestPlug[] = spec.fractions.map((f, i) => ({
    n: i + 1,
    speed: material.cutSpeed * f,
    at: { x: spec.blockX + spec.gap + i * (N + spec.gap), y: spec.blockY + spec.lift },
  }));
  for (const p of plugs) {
    const entry = { x: p.at.x, y: below };
    go(entry, machine.jogSpeed, 'jog');
    go(p.at, p.speed, 'cut');
    go({ x: p.at.x + N, y: p.at.y }, p.speed, 'cut');
    go({ x: p.at.x + N, y: p.at.y + N }, p.speed, 'cut');
    go({ x: p.at.x, y: p.at.y + N }, p.speed, 'cut');
    go(p.at, p.speed, 'cut');
    go(entry, p.speed, 'cut');
  }
  go(machine.home, machine.jogSpeed, 'jog');
  const start = { left: machine.home, right: machine.home };
  return { gcode: writeGcode(start, moves, machine, material.cutSpeed, { wireWatts: material.wireWatts }), plugs };
}

/** Kerf table rows from measured plug sizes (blank/invalid measurements are skipped). */
export function kerfTableFromMeasurements(plugs: KerfTestPlug[], nominal: number, measured: (number | null)[]): KerfPoint[] {
  return plugs
    .map((p, i) => ({ speed: p.speed, size: measured[i] }))
    .filter((m): m is { speed: number; size: number } => m.size !== null && Number.isFinite(m.size) && m.size > 0)
    .map((m) => ({ speed: m.speed, kerf: Math.max(0, nominal - m.size) }));
}
