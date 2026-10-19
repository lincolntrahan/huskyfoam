import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateCut } from '../src/core/cut/pipeline';
import { defaultTransforms, type Transforms } from '../src/core/cut/transform';
import { applyAffine, chain, invert, rotation, scaleXY, translate } from '../src/core/geom/affine';
import { arcLoop, pointAtS } from '../src/core/geom/arc';
import { autoChord } from '../src/core/geom/chord';
import { signedArea } from '../src/core/geom/profile';
import type { Vec2 } from '../src/core/geom/vec';
import { loadDxfProfile } from '../src/core/io/loadProfile';
import { defaultJob, machines, materials } from '../src/core/presets';
import { addSplit } from '../src/core/sync/edit';
import { autoSync } from '../src/core/sync/sync';
import type { JobSettings } from '../src/core/types';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const machine = machines.find((m) => m.id === 'shop-4axis')!;
const material = materials.find((m) => m.id === 'default-foam')!;
const root = loadDxfProfile(fx('vtail-root.dxf'), 'in').profile!;
const tip = loadDxfProfile(fx('vtail-tip.dxf'), 'in').profile!;
const OFFSET = { x: 4.7221, y: 0.7001 };

function job(t: (x: Transforms) => void, patch: Partial<JobSettings> = {}): JobSettings {
  const j = defaultJob(machine, material);
  j.span = 12.07;
  j.rootFaceFromLeft = (machine.carriageSpacing - j.span) / 2;
  j.kerf = { root: 0.0998, tip: 0.1116 };
  j.offset = OFFSET;
  j.transforms = defaultTransforms();
  t(j.transforms);
  return { ...j, ...patch };
}
const run = (t: (x: Transforms) => void, patch: Partial<JobSettings> = {}) => generateCut(root, tip, job(t, patch), machine);

function insidePolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

describe('affine maps', () => {
  it('invert undoes a compound map', () => {
    const m = chain(translate({ x: -2, y: 1 }), scaleXY(-1.5, 1.5), rotation(0.3), translate({ x: 7, y: -3 }));
    const p = { x: 1.25, y: -0.75 };
    const q = applyAffine(invert(m), applyAffine(m, p));
    expect(q.x).toBeCloseTo(p.x, 12);
    expect(q.y).toBeCloseTo(p.y, 12);
  });
});

describe('automatic chord', () => {
  it('ignores the tabs on the V-tail and lands mid-gap at the blunt LE/TE', () => {
    const c = autoChord(root);
    expect(c.le.x).toBeCloseTo(0.0253, 4);
    expect(c.te.x).toBeCloseTo(10.8851, 4);
    expect(c.le.y).toBeCloseTo(0.0617, 3);
    const t = autoChord(tip);
    expect(t.le.x).toBeCloseTo(3.8593, 4);
    expect(t.te.x).toBeCloseTo(10.8851, 3);
    // the tip TE spline ends differ by ~5e-5 in X: still a tie, so the TE is mid-gap
    expect(t.te.y).toBeCloseTo(0.0617, 3);
    expect(t.le.y).toBeCloseTo(0.0617, 3);
  });
});

describe('twist', () => {
  const base = run(() => {});
  it('positive twist raises the LE about the 25% chord pivot, which stays put', () => {
    const res = run((t) => (t.tip.twistDeg = 5));
    expect(res.errors).toEqual([]);
    const b = base.chord!.tip;
    const c = res.chord!.tip;
    expect(c.pivot.x).toBeCloseTo(b.pivot.x, 12);
    expect(c.pivot.y).toBeCloseTo(b.pivot.y, 12);
    // the chord line (LE -> TE) turns 5° clockwise, i.e. the LE comes up
    const ang = (q: { le: Vec2; te: Vec2 }) => Math.atan2(q.te.y - q.le.y, q.te.x - q.le.x);
    expect(((ang(c) - ang(b)) * 180) / Math.PI).toBeCloseTo(-5, 9);
    expect(c.le.y).toBeGreaterThan(b.le.y);
    expect(c.te.y).toBeLessThan(b.te.y);
    // the root is untouched
    expect(res.chord!.root).toEqual(base.chord!.root);
  });

  it('negative twist (washout) lowers the LE', () => {
    const res = run((t) => (t.tip.twistDeg = -3));
    expect(res.chord!.tip.le.y).toBeLessThan(base.chord!.tip.le.y);
  });

  it('can pivot about the TE instead', () => {
    const res = run((t) => {
      t.tip.twistDeg = 4;
      t.tip.pivot = 'te';
    });
    expect(res.chord!.tip.te.x).toBeCloseTo(base.chord!.tip.te.x, 12);
    expect(res.chord!.tip.te.y).toBeCloseTo(base.chord!.tip.te.y, 12);
  });
});

describe('scale and move', () => {
  it('scales the chord about the pivot', () => {
    const base = run(() => {});
    const res = run((t) => (t.tip.scale = 1.5));
    expect(res.errors).toEqual([]);
    const chord = (c: { le: Vec2; te: Vec2 }) => Math.hypot(c.te.x - c.le.x, c.te.y - c.le.y);
    expect(chord(res.chord!.tip)).toBeCloseTo(1.5 * chord(base.chord!.tip), 9);
  });

  it('rejects a zero scale', () => {
    expect(run((t) => (t.root.scale = 0)).errors[0]).toMatch(/Scale must be greater than zero/);
  });

  it('moves one profile without touching the other', () => {
    const base = run(() => {});
    const res = run((t) => (t.tip.move = { x: 0.5, y: -0.25 }));
    expect(res.chord!.tip.le.x - base.chord!.tip.le.x).toBeCloseTo(0.5, 12);
    expect(res.chord!.tip.le.y - base.chord!.tip.le.y).toBeCloseTo(-0.25, 12);
    expect(res.chord!.root).toEqual(base.chord!.root);
  });
});

describe('flips', () => {
  it('flip horizontal puts the TE first, keeps the outline CCW and the kerf outside', () => {
    const res = run((t) => (t.flipH = true));
    expect(res.errors).toEqual([]);
    expect(res.gcode).not.toBe('');
    expect(res.chord!.root.te.x).toBeLessThan(res.chord!.root.le.x);
    expect(signedArea(res.profilePts.root)).toBeGreaterThan(0);
    const outsideCount = res.kerfStations.filter((s) => !insidePolygon(s.r, res.profilePts.root)).length;
    expect(outsideCount).toBe(res.kerfStations.length);
  });

  it('keeps hand-placed splits on the same physical points through a mirror flip', () => {
    const auto = autoSync(root, tip, 30);
    const arcs = { root: arcLoop(root), tip: arcLoop(tip) };
    const ed = addSplit(auto, null, arcs, 'root', (auto.root[1] + auto.root[2]) / 2)!;
    const res = run((t) => (t.flipH = true), { sync: ed.sync });
    expect(res.errors).toEqual([]);
    expect(res.stats.segments).toBe(9);
    // the cut-space sync the UI edits lines up index-for-index with the split markers
    res.sync!.root.forEach((s, k) => {
      const p = pointAtS(res.arcs!.root, s);
      expect(p.x).toBeCloseTo(res.splitPts.root[k].x, 9);
      expect(p.y).toBeCloseTo(res.splitPts.root[k].y, 9);
    });
    // the flip mirrors X about the pivot: every hand-placed split lands on its mirror image
    const px = res.chord!.root.pivot.x;
    const key = (p: Vec2) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`;
    const cutSplits = new Set(res.splitPts.root.map(key));
    const unflipped = run(() => {}, { sync: ed.sync });
    for (const p of unflipped.splitPts.root) expect(cutSplits.has(key({ x: 2 * px - p.x, y: p.y }))).toBe(true);
    // and converting back gives the stored (raw) sync
    const back = res.syncToJob!(res.sync!);
    back.root.forEach((s, k) => expect(s).toBeCloseTo(ed.sync.root[k], 9));
  });

  it('flipping both ways is a 180° rotation, not a mirror', () => {
    const res = run((t) => {
      t.flipH = true;
      t.flipV = true;
    });
    expect(res.errors).toEqual([]);
    expect(signedArea(res.profilePts.root)).toBeGreaterThan(0);
  });
});
