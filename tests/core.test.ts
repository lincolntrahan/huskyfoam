import { describe, expect, it } from 'vitest';
import { testMachine } from './testMachine';
import { offsetStations, type Station } from '../src/core/cut/kerf';
import { generateCut, projector } from '../src/core/cut/pipeline';
import { evalNurbs } from '../src/core/geom/nurbs';
import { chainProfile, signedArea, type Profile } from '../src/core/geom/profile';
import { distToSegment, len, type Vec2 } from '../src/core/geom/vec';
import { parseGcode } from '../src/core/gcode/parser';
import { parseDxf } from '../src/core/io/dxf';
import { defaultJob, materials } from '../src/core/presets';
import { resamplePair } from '../src/core/sync/resample';
import type { MachinePreset } from '../src/core/types';

const machine: MachinePreset = testMachine;
const material = materials.find((m) => m.id === 'default-foam')!;

function dxf(entities: string): string {
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n1\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}
const line = (a: Vec2, b: Vec2) => `0\nLINE\n8\n0\n10\n${a.x}\n20\n${a.y}\n11\n${b.x}\n21\n${b.y}\n`;
const polygonDxf = (pts: Vec2[]) => dxf(pts.map((p, i) => line(p, pts[(i + 1) % pts.length])).join(''));
const square = (s: number, x = 0, y = 0) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];
const profileOf = (text: string): Profile => chainProfile(parseDxf(text).edges).profile!;

describe('NURBS', () => {
  it('reproduces a quarter circle with a rational quadratic', () => {
    const c = { degree: 2, knots: [0, 0, 0, 1, 1, 1], ctrl: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], weights: [1, Math.SQRT1_2, 1] };
    for (const u of [0, 0.1, 0.37, 0.5, 0.9, 1]) expect(len(evalNurbs(c, u))).toBeCloseTo(1, 12);
  });
});

describe('DXF import', () => {
  it('reads units and ignores text', () => {
    const r = parseDxf(dxf(line({ x: 0, y: 0 }, { x: 1, y: 0 }) + '0\nMTEXT\n1\nSOLIDWORKS Educational Product.\n'));
    expect(r.units).toBe('in');
    expect(r.edges).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });

  it('turns a bulged LWPOLYLINE segment into a semicircle', () => {
    const r = parseDxf(dxf('0\nLWPOLYLINE\n90\n2\n70\n0\n10\n0\n20\n0\n42\n1\n10\n2\n20\n0\n'));
    const pts = r.edges[0].pts;
    for (const p of pts) expect(Math.hypot(p.x - 1, p.y)).toBeCloseTo(1, 9);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(-1, 3); // CCW from (0,0) to (2,0) dips below
  });
});

describe('chaining', () => {
  it('builds a CCW loop from CW, out-of-order, reversed lines', () => {
    const s = square(1);
    const text = dxf(line(s[1], s[0]) + line(s[2], s[3]) + line(s[3], s[0]) + line(s[1], s[2]));
    const p = profileOf(text);
    expect(signedArea(p.pts)).toBeCloseTo(1, 12);
    expect(p.breaks).toHaveLength(4);
  });
});

describe('resampling', () => {
  it('gives both sides the same count, matched by arc length', () => {
    const a = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const b = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }];
    for (const mode of ['uniform', 'adaptive'] as const) {
      const r = resamplePair(a, b, { mode, step: 0.5, tolerance: 0.001, maxStep: 0.5 });
      expect(r.a.length).toBe(r.b.length);
      expect(r.a.at(-1)).toEqual({ x: 10, y: 0 });
      expect(r.b.at(-1)).toEqual({ x: 2, y: 2 });
    }
  });
});

describe('kerf offset', () => {
  it('keeps every offset point exactly half a kerf outside a square, with rounded corners', () => {
    const sq = square(1);
    const st: Station[] = [];
    sq.forEach((p, i) => {
      const q = sq[(i + 1) % 4];
      for (let k = 0; k < 10; k++) {
        const pt = { x: p.x + ((q.x - p.x) * k) / 10, y: p.y + ((q.y - p.y) * k) / 10 };
        st.push({ r: pt, t: pt, seg: i, boundary: k === 0 });
      }
    });
    const out = offsetStations(st, () => 0.2, () => 0.4);
    expect(out.length).toBeGreaterThan(st.length); // arcs added
    const toSquare = (p: Vec2) => Math.min(...sq.map((a, i) => distToSegment(p, a, sq[(i + 1) % 4])));
    for (const s of out) {
      expect(toSquare(s.r)).toBeCloseTo(0.1, 9);
      expect(toSquare(s.t)).toBeCloseTo(0.2, 9);
    }
  });

  it('uses the miter point at a concave corner', () => {
    // L-shape (CCW); the inside corner is at (1,1)
    const L = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 2 }];
    const st = L.map((p, i) => ({ r: p, t: p, seg: i, boundary: true }));
    const out = offsetStations(st, () => 0.2, () => 0.2);
    expect(out.some((s) => Math.abs(s.r.x - 1.1) < 1e-9 && Math.abs(s.r.y - 1.1) < 1e-9)).toBe(true);
  });
});

describe('projection', () => {
  const job = defaultJob(machine, material);
  it('a straight wire stays straight', () => {
    const p = projector(job, machine)({ x: 3, y: 4 }, { x: 3, y: 4 });
    expect(p.left).toEqual({ x: 3, y: 4 });
    expect(p.right).toEqual({ x: 3, y: 4 });
  });
  it('extrapolates linearly to the carriage planes', () => {
    // block centered, span = spacing/3 -> carriages are one span outside each face
    const p = projector(job, machine)({ x: 0, y: 0 }, { x: 1, y: 2 });
    expect(p.left.x).toBeCloseTo(-1, 12);
    expect(p.left.y).toBeCloseTo(-2, 12);
    expect(p.right.x).toBeCloseTo(2, 12);
    expect(p.right.y).toBeCloseTo(4, 12);
  });
  it('swaps sides when the root is on the right', () => {
    const p = projector({ ...job, rootSide: 'right' }, machine)({ x: 0, y: 0 }, { x: 1, y: 2 });
    expect(p.left.x).toBeCloseTo(2, 12);
    expect(p.right.x).toBeCloseTo(-1, 12);
  });
});

describe('full cut', () => {
  const sq = profileOf(polygonDxf(square(2, 5, 2)));

  it('round-trips through the G-code parser with G93 timing', () => {
    const job = defaultJob(machine, material);
    const res = generateCut(sq, sq, job, machine);
    const parsed = parseGcode(res.gcode, machine.axes);
    expect(parsed[0].rapid).toBe(true);
    const cuts = parsed.slice(1);
    expect(cuts).toHaveLength(res.moves.length);
    cuts.forEach((m, i) => {
      expect(m.inverseTime).toBe(true);
      expect(m.left.x).toBeCloseTo(res.moves[i].left.x, 5);
      expect(m.right.y).toBeCloseTo(res.moves[i].right.y, 5);
      expect(1 / m.f).toBeCloseTo(res.moves[i].minutes, 6);
    });
  });

  it('caps carriage speed and warns', () => {
    const slow = { ...machine, maxSpeed: 5 };
    const res = generateCut(sq, sq, { ...defaultJob(machine, material), cutSpeed: 20 }, slow);
    expect(res.warnings.some((w) => w.message.includes('cap'))).toBe(true);
    let prev = res.start;
    for (const m of res.moves) {
      const v = Math.max(Math.hypot(m.left.x - prev.left.x, m.left.y - prev.left.y), Math.hypot(m.right.x - prev.right.x, m.right.y - prev.right.y)) / m.minutes;
      expect(v).toBeLessThanOrEqual(5 + 1e-9);
      prev = m;
    }
  });

  it('refuses to cut when root and tip have different segment counts', () => {
    const tri = profileOf(polygonDxf([{ x: 5, y: 2 }, { x: 7, y: 2 }, { x: 6, y: 4 }]));
    const res = generateCut(sq, tri, defaultJob(machine, material), machine);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/4 segments but tip has 3/);
    expect(res.gcode).toBe('');
  });

  it('starts and ends every plan at home', () => {
    const res = generateCut(sq, sq, defaultJob(machine, material), machine);
    expect(res.start.left).toEqual(machine.home);
    expect(res.moves.at(-1)!.left).toEqual(machine.home);
  });
});

describe('choosing DXF entities', () => {
  const sq = square(2, 5, 2);
  const text = dxf(sq.map((p, i) => line(p, sq[(i + 1) % 4])).join('') + line({ x: 0, y: 0 }, { x: 1, y: 3 }) + '0\nMTEXT\n10\n0\n20\n-1\n40\n0.2\n1\nSOLIDWORKS Educational Product.\n');

  it('auto-picks the closed outline and leaves stray lines and text out', async () => {
    const { loadDxfProfile } = await import('../src/core/io/loadProfile');
    const r = loadDxfProfile(text, 'in');
    expect(r.edges).toHaveLength(5);
    expect(r.used).toEqual([0, 1, 2, 3]);
    expect(r.selected).toEqual([0, 1, 2, 3]);
    expect(r.texts.map((t) => t.text)).toEqual(['SOLIDWORKS Educational Product.']);
    expect(r.profile).not.toBeNull();
  });

  it('uses only the chosen entities', async () => {
    const { loadDxfProfile } = await import('../src/core/io/loadProfile');
    // three sides of the square: one open contour
    const open = loadDxfProfile(text, 'in', [0, 1, 2]);
    expect(open.contours).toHaveLength(1);
    expect(open.contours[0].closed).toBe(false);
    expect(open.warnings.join(' ')).toMatch(/no closed outline/);
    const none = loadDxfProfile(text, 'in', []);
    expect(none.warnings).toContain('No entities selected.');
    // a chosen stray entity becomes its own open contour, after the closed outline
    const withStray = loadDxfProfile(text, 'in', [0, 1, 2, 3, 4]);
    expect(withStray.contours.map((c) => c.closed !== false)).toEqual([true, false]);
    expect(withStray.used).toEqual([0, 1, 2, 3, 4]);
    expect(withStray.selected).toEqual([0, 1, 2, 3, 4]);
  });
});
