import type { AxisLetters } from '../types';
import type { CarriagePos } from './writer';

export interface ParsedMove extends CarriagePos {
  rapid: boolean;
  /** Raw F word in effect for this move. */
  f: number;
  inverseTime: boolean;
}

/** Read 4-axis foam G-code back into carriage positions (absolute mode assumed). */
export function parseGcode(text: string, axes: AxisLetters): ParsedMove[] {
  const pos = { leftH: 0, leftV: 0, rightH: 0, rightV: 0 };
  const byLetter: Record<string, keyof typeof pos> = {
    [axes.leftH]: 'leftH',
    [axes.leftV]: 'leftV',
    [axes.rightH]: 'rightH',
    [axes.rightV]: 'rightV',
  };
  let f = 0;
  let inverseTime = false;
  let motion: 0 | 1 | null = null;
  const out: ParsedMove[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\(.*?\)|;.*$/g, '').toUpperCase();
    let moved = false;
    for (const [, letter, value] of line.matchAll(/([A-Z])\s*(-?\d*\.?\d+)/g)) {
      const v = parseFloat(value);
      if (letter === 'G') {
        if (v === 0 || v === 1) motion = v;
        else if (v === 93) inverseTime = true;
        else if (v === 94) inverseTime = false;
      } else if (letter === 'F') f = v;
      else if (letter in byLetter) {
        pos[byLetter[letter]] = v;
        moved = true;
      }
    }
    if (moved && motion !== null) {
      out.push({
        left: { x: pos.leftH, y: pos.leftV },
        right: { x: pos.rightH, y: pos.rightV },
        rapid: motion === 0,
        f,
        inverseTime,
      });
    }
  }
  return out;
}
