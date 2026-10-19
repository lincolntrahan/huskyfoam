import { lerp, type Vec2 } from '../geom/vec';
import type { CarriagePos, Move } from '../gcode/writer';

/** When each move starts and ends (minutes from the start), including corner dwells. */
export interface Timeline {
  begin: number[];
  end: number[];
  /** Total job time, minutes. */
  total: number;
}

export function buildTimeline(moves: Move[]): Timeline {
  const begin: number[] = [];
  const end: number[] = [];
  let t = 0;
  for (const m of moves) {
    begin.push(t);
    t += m.minutes;
    end.push(t);
    t += (m.dwell ?? 0) / 60;
  }
  return { begin, end, total: t };
}

export interface SimState extends CarriagePos {
  /** Moves fully done. */
  done: number;
  /** Fraction of the current move done (0 when between moves or dwelling). */
  frac: number;
  dwelling: boolean;
}

/** Carriage positions at `time` minutes into the job. */
export function stateAt(start: CarriagePos, moves: Move[], tl: Timeline, time: number): SimState {
  if (!moves.length || time <= 0) return { ...start, done: 0, frac: 0, dwelling: false };
  if (time >= tl.total) {
    const last = moves[moves.length - 1];
    return { left: last.left, right: last.right, done: moves.length, frac: 0, dwelling: false };
  }
  // last move that has begun
  let lo = 0;
  let hi = moves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.begin[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const m = moves[i];
  const from: CarriagePos = i === 0 ? start : moves[i - 1];
  if (time >= tl.end[i]) return { left: m.left, right: m.right, done: i + 1, frac: 0, dwelling: true };
  const f = m.minutes > 0 ? (time - tl.begin[i]) / m.minutes : 1;
  const at = (a: Vec2, b: Vec2) => lerp(a, b, f);
  return { left: at(from.left, m.left), right: at(from.right, m.right), done: i, frac: f, dwelling: false };
}
