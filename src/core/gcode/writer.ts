import type { Vec2 } from '../geom/vec';
import type { MachinePreset } from '../types';

/** A synchronized move of both carriages. */
export interface Move {
  left: Vec2;
  right: Vec2;
  /** Duration in minutes. */
  minutes: number;
  /** Made by an inserted line (lead-in/out, run-out, jog) rather than a profile segment. */
  lead: boolean;
  speed?: 'cut' | 'jog';
  /** Plan step that produced this move. */
  step?: number;
  /** Corner dwell after this move, in seconds. */
  dwell?: number;
}

export interface CarriagePos {
  left: Vec2;
  right: Vec2;
}

export interface WriteOptions {
  /** Wire power from the material; adds a comment and fills the {wireWatts} header token. */
  wireWatts?: number | null;
  /** Wire diameter from the material; adds a comment. */
  wireDiameter?: number | null;
}

function axisWords(p: CarriagePos, m: MachinePreset): string {
  const vals = { leftH: p.left.x, leftV: p.left.y, rightH: p.right.x, rightV: p.right.y };
  // never print "-0.000000" for a value that rounds to zero
  const fmt = (v: number) => v.toFixed(m.decimals).replace(/^-(0\.?0*)$/, '$1');
  return m.axisOrder.map((k) => `${m.axes[k]}${fmt(vals[k])}`).join('');
}

/** Shortest decimal form (no trailing zeros), for dwell times and watts. */
const short = (v: number, digits: number) => String(Number(v.toFixed(digits)));

export function dwellLine(seconds: number, m: MachinePreset): string {
  return m.dwellUnits === 'ms' ? `G4 P${Math.round(seconds * 1000)}` : `G4 P${short(seconds, 3)}`;
}

export function writeGcode(start: CarriagePos, moves: Move[], m: MachinePreset, cutSpeed: number, opts: WriteOptions = {}): string {
  const lines: string[] = [];
  const watts = opts.wireWatts;
  const header = m.header
    .replaceAll('{units}', m.units === 'in' ? 'G20' : 'G21')
    .replaceAll('{cutSpeed}', cutSpeed.toFixed(6))
    .replaceAll('{wireWatts}', watts != null ? short(watts, 1) : '');
  if (watts != null) lines.push(`(Set wire power to ${short(watts, 1)} W: volts across the wire bearings x supply amps)`);
  if (opts.wireDiameter != null) lines.push(`(Wire diameter ${short(opts.wireDiameter, 4)} ${m.units})`);
  lines.push(...header.split(/\r?\n/).filter((l) => l.trim()));
  lines.push(`G0${axisWords(start, m)}`);
  lines.push(m.feedMode);
  let prev = start;
  for (const mv of moves) {
    let f: number;
    if (m.feedMode === 'G93') f = 1 / mv.minutes;
    else {
      const d = Math.hypot(mv.left.x - prev.left.x, mv.left.y - prev.left.y, mv.right.x - prev.right.x, mv.right.y - prev.right.y);
      f = d / mv.minutes;
    }
    lines.push(`G1${axisWords(mv, m)}F${f.toFixed(6)}`);
    if (mv.dwell && mv.dwell > 0) lines.push(dwellLine(mv.dwell, m));
    prev = mv;
  }
  lines.push(...m.footer.split(/\r?\n/).filter((l) => l.trim()));
  return lines.join('\n') + '\n';
}
