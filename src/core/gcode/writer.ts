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
}

export interface CarriagePos {
  left: Vec2;
  right: Vec2;
}

function axisWords(p: CarriagePos, m: MachinePreset): string {
  const vals = { leftH: p.left.x, leftV: p.left.y, rightH: p.right.x, rightV: p.right.y };
  return m.axisOrder.map((k) => `${m.axes[k]}${vals[k].toFixed(m.decimals)}`).join('');
}

export function writeGcode(start: CarriagePos, moves: Move[], m: MachinePreset, cutSpeed: number): string {
  const lines: string[] = [];
  const header = m.header
    .replaceAll('{units}', m.units === 'in' ? 'G20' : 'G21')
    .replaceAll('{cutSpeed}', cutSpeed.toFixed(6));
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
    prev = mv;
  }
  lines.push(...m.footer.split(/\r?\n/).filter((l) => l.trim()));
  return lines.join('\n') + '\n';
}
