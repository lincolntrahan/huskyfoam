import { describe, expect, it } from 'vitest';
import { stockTrim, type StockTrimSpec } from '../src/core/cut/stockTrim';
import { parseGcode } from '../src/core/gcode/parser';
import { testMachine } from './testMachine';

const spec: StockTrimSpec = { length: 12, thickness: 2, setback: 1, trimFront: 0.5, backOffset: 0.25, kerf: 0.1, clearance: 0.5, speed: 8 };

describe('stock trim', () => {
  const res = stockTrim(spec, testMachine);

  it('puts the kept faces exactly the finished length apart', () => {
    expect(res.errors).toEqual([]);
    // wire centre half a kerf into the waste on each side
    expect(res.front).toBeCloseTo(1.5 - 0.05, 12);
    expect(res.back).toBeCloseTo(13.5 + 0.05, 12);
    expect(res.back - res.front - spec.kerf).toBeCloseTo(spec.length, 12);
    expect(res.up).toBeCloseTo(res.back + 0.25, 12);
  });

  it('cuts down the front, pulls out, jogs over, cuts down the back, steps back and cuts up', () => {
    const p = res.path.map((s) => [+s.p.x.toFixed(3), +s.p.y.toFixed(3), s.kind]);
    expect(p).toEqual([
      [testMachine.home.x, testMachine.home.y, 'jog'],
      [testMachine.home.x, 2.5, 'jog'],
      [1.45, 2.5, 'jog'],
      [1.45, 0, 'cut'],
      [0.5, 0, 'cut'],
      [0.5, 2.5, 'jog'],
      [13.55, 2.5, 'jog'],
      [13.55, 0, 'cut'],
      [13.8, 0, 'cut'],
      [13.8, 2.5, 'cut'],
      [testMachine.home.x, 2.5, 'jog'],
      [testMachine.home.x, testMachine.home.y, 'jog'],
    ]);
  });

  it('moves both carriages together (a straight wire)', () => {
    const g = parseGcode(res.gcode, testMachine.axes);
    expect(g.length).toBeGreaterThan(5);
    for (const m of g) {
      expect(m.left.x).toBeCloseTo(m.right.x, 6);
      expect(m.left.y).toBeCloseTo(m.right.y, 6);
    }
  });

  it('refuses a back step that would recut the kept face, and positions past the travel', () => {
    expect(stockTrim({ ...spec, backOffset: 0.05 }, testMachine).errors.join(' ')).toMatch(/Back step/);
    expect(stockTrim({ ...spec, length: 50 }, testMachine).errors.join(' ')).toMatch(/X travel/);
    expect(stockTrim({ ...spec, setback: 0, trimFront: 0 }, testMachine).errors.join(' ')).toMatch(/in front of X = 0/);
  });
});
