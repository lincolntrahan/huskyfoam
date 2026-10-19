import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateCut, profilePlanes } from '../src/core/cut/pipeline';
import { defaultLayout, placeJob, placeLayout } from '../src/core/cut/placement';
import { loadDxfProfile } from '../src/core/io/loadProfile';
import { normalizeJob } from '../src/core/io/project';
import { defaultJob, materials } from '../src/core/presets';
import type { JobSettings, MachinePreset } from '../src/core/types';
import { testMachine } from './testMachine';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// home at the origin, like the shop machine
const machine: MachinePreset = { ...testMachine, home: { x: 0, y: 0 } };
const material = materials.find((m) => m.id === 'default-foam')!;
const root = [loadDxfProfile(fx('vtail-root.dxf'), 'in').profile!];
const tip = [loadDxfProfile(fx('vtail-tip.dxf'), 'in').profile!];

function job(layout: Partial<JobSettings['layout'] & object> = {}): JobSettings {
  const j = defaultJob(machine, material);
  j.profile = { distance: 12.07, inset: null };
  j.kerf = { mode: 'fixed', root: 0.0998, tip: 0.1116 };
  j.layout = { ...defaultLayout(machine, 12.07), floor: 0.5, ...layout };
  return j;
}
const place = (j: JobSettings) => placeJob(j, root, tip, machine);
const cut = (j: JobSettings) => generateCut(root, tip, place(j), machine);

describe('automatic placement', () => {
  it('puts the lowest profile point the floor offset above Y = 0', () => {
    const res = cut(job({ floor: 0.75 }));
    const ys = [...res.profilePts.root, ...res.profilePts.tip].map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(0.75, 9);
  });

  it('pushes the part toward X = 0 until a carriage would go past it', () => {
    const res = cut(job());
    expect(res.errors).toEqual([]);
    const xs = res.moves.flatMap((m) => [m.left.x, m.right.x]);
    expect(Math.min(...xs)).toBeGreaterThan(-1e-9);
    // something actually touches X = 0 besides home
    const cutXs = res.moves.filter((m) => !m.lead).flatMap((m) => [m.left.x, m.right.x]);
    expect(Math.min(...cutXs)).toBeCloseTo(0, 9);
  });

  it('keeps the profiles where they are relative to each other', () => {
    const a = place(job());
    const moved = job();
    moved.transforms.tip.move = { x: 1, y: 0.2 };
    const b = place(moved);
    const ra = generateCut(root, tip, a, machine).profilePts;
    const rb = generateCut(root, tip, b, machine).profilePts;
    const d = (r: typeof ra) => ({ x: r.tip[0].x - r.root[0].x, y: r.tip[0].y - r.root[0].y });
    expect(d(rb).x - d(ra).x).toBeCloseTo(1, 9);
    expect(d(rb).y - d(ra).y).toBeCloseTo(0.2, 9);
  });

  it('holds the offset while dragging', () => {
    const a = place(job());
    const moved = job();
    moved.transforms.root.move = { x: 3, y: 0 };
    expect(placeJob(moved, root, tip, machine, a.offset).offset).toEqual(a.offset);
  });
});

describe('profiles along the wire', () => {
  it('puts the left profile its distance from the left carriage, whichever side the root is on', () => {
    const left = place(job({ profileFromLeft: 10 }));
    expect(profilePlanes(left).zr).toBeCloseTo(10, 9);
    expect(profilePlanes(left).zt).toBeCloseTo(22.07, 9);
    const rj = job({ profileFromLeft: 10 });
    rj.rootSide = 'right';
    const right = place(rj);
    expect(profilePlanes(right).zt).toBeCloseTo(10, 9);
    expect(profilePlanes(right).zr).toBeCloseTo(22.07, 9);
  });

  it('places the block ends by the along-wire choice', () => {
    const block = { w: 0, h: 0, len: 14 };
    expect(place(job({ profileFromLeft: 10, block, alongWire: 'center' })).rootFaceFromLeft).toBeCloseTo(10 + 12.07 / 2 - 7, 9);
    expect(place(job({ profileFromLeft: 10, block, alongWire: 'left' })).rootFaceFromLeft).toBeCloseTo(10, 9);
    const r = place(job({ profileFromLeft: 10, block, alongWire: 'right' }));
    expect(r.rootFaceFromLeft + r.span).toBeCloseTo(22.07, 9);
  });
});

describe('block around the profiles', () => {
  const block = { w: 12, h: 2, len: 0 };
  const box = (j: JobSettings) => {
    const p = place(j);
    const res = generateCut(root, tip, p, machine);
    const pts = [...res.profilePts.root, ...res.profilePts.tip];
    return { b: p.block, x0: Math.min(...pts.map((q) => q.x)), x1: Math.max(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), y1: Math.max(...pts.map((q) => q.y)) };
  };

  it('centres, or puts the profiles against a side, along the chord', () => {
    const c = box(job({ block, alongChord: 'center' }));
    expect(c.b.x + c.b.w / 2).toBeCloseTo((c.x0 + c.x1) / 2, 9);
    const l = box(job({ block, alongChord: 'left' }));
    expect(l.b.x).toBeCloseTo(l.x0, 9);
    const r = box(job({ block, alongChord: 'right' }));
    expect(r.b.x + r.b.w).toBeCloseTo(r.x1, 9);
  });

  it('centres, or puts the profiles on the bottom or top face, vertically', () => {
    const m = box(job({ block, vertical: 'middle' }));
    expect(m.b.y + m.b.h / 2).toBeCloseTo((m.y0 + m.y1) / 2, 9);
    expect(box(job({ block, vertical: 'bottom' })).b.y).toBeCloseTo(0.5, 9);
    const t = box(job({ block, vertical: 'top' }));
    expect(t.b.y + t.b.h).toBeCloseTo(t.y1, 9);
  });

  it('has no block when its size is not set', () => {
    expect(place(job()).block).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('older projects', () => {
  it('get a layout that keeps their profile planes', () => {
    const old = { ...defaultJob(testMachine, material), span: 12.07, rootFaceFromLeft: 11.965, block: { x: 4, y: 0.5, w: 13, h: 1.4 } } as Record<string, unknown>;
    delete old.layout;
    const j = normalizeJob(old, testMachine, material);
    expect(j.layout!.profileFromLeft).toBeCloseTo(11.965, 9);
    expect(j.layout!.block).toEqual({ w: 13, h: 1.4, len: 12.07 });
    expect(profilePlanes(placeJob(j, root, tip, testMachine)).zr).toBeCloseTo(11.965, 9);
  });
});

describe('carriages and the floor', () => {
  it('defaults to 0.25 in above the floor', () => {
    expect(defaultLayout(machine, 12).floor).toBe(0.25);
  });

  it('leaves a gentle part at the floor offset', () => {
    expect(placeLayout(job({ floor: 0.25 }), root, tip, machine).raisedTo).toBeNull();
  });

  it('raises a steep part just enough to keep the lower carriage in travel', () => {
    const steep = job({ floor: 0.25 });
    steep.transforms.tip.move = { x: 0, y: 3 }; // tip well above the root: the root-side carriage dips
    const p = placeLayout(steep, root, tip, machine);
    expect(p.raisedTo).not.toBeNull();
    expect(p.raisedTo!).toBeGreaterThan(0.25);
    const res = generateCut(root, tip, p.job, machine);
    const ys = [...res.profilePts.root, ...res.profilePts.tip].map((q) => q.y);
    expect(Math.min(...ys)).toBeCloseTo(p.raisedTo!, 9);
    // the cut's lowest carriage point sits on the travel limit; nothing goes below it
    const carY = res.moves.filter((m) => !m.lead).flatMap((m) => [m.left.y, m.right.y]);
    expect(Math.min(...carY)).toBeCloseTo(machine.travel.y[0], 9);
    expect(res.warnings.map((w) => w.message).join(' ')).not.toMatch(/travel limits/);
  });
});
