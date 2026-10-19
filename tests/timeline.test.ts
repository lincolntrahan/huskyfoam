import { describe, expect, it } from 'vitest';
import type { Move } from '../src/core/gcode/writer';
import { buildTimeline, stateAt } from '../src/core/sim/timeline';

const P = (x: number) => ({ x, y: 0 });
const start = { left: P(0), right: P(0) };
const moves: Move[] = [
  { left: P(1), right: P(2), minutes: 1, lead: false },
  { left: P(3), right: P(2), minutes: 2, lead: false, dwell: 30 },
  { left: P(3), right: P(5), minutes: 1, lead: false },
];

describe('playback timeline', () => {
  const tl = buildTimeline(moves);
  it('adds up move times and dwells', () => {
    expect(tl.begin).toEqual([0, 1, 3.5]);
    expect(tl.end).toEqual([1, 3, 4.5]);
    expect(tl.total).toBe(4.5);
  });
  it('interpolates both carriages inside a move', () => {
    const s = stateAt(start, moves, tl, 0.5);
    expect(s.left).toEqual(P(0.5));
    expect(s.right).toEqual(P(1));
    expect(s.done).toBe(0);
    const s2 = stateAt(start, moves, tl, 2);
    expect(s2.left.x).toBeCloseTo(2, 12);
    expect(s2.done).toBe(1);
  });
  it('holds still during a dwell, and clamps at the ends', () => {
    const d = stateAt(start, moves, tl, 3.2);
    expect(d.dwelling).toBe(true);
    expect(d.left).toEqual(P(3));
    expect(d.done).toBe(2);
    expect(stateAt(start, moves, tl, -1)).toMatchObject({ left: P(0), done: 0 });
    expect(stateAt(start, moves, tl, 99)).toMatchObject({ left: P(3), right: P(5), done: 3 });
  });
});
