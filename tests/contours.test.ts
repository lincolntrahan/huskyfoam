import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { autoPairs, insidePolygon } from '../src/core/cut/contours';
import { generateCut } from '../src/core/cut/pipeline';
import { arcLoop } from '../src/core/geom/arc';
import type { Profile } from '../src/core/geom/profile';
import type { Vec2 } from '../src/core/geom/vec';
import { loadDxfProfile } from '../src/core/io/loadProfile';
import { segSplits } from '../src/core/plan/model';
import { defaultJob, materials } from '../src/core/presets';
import { addSplit, moveSplit } from '../src/core/sync/edit';
import type { JobSettings } from '../src/core/types';
import { testMachine } from './testMachine';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const machine = testMachine;
const material = materials.find((m) => m.id === 'default-foam')!;

/** Thickness centre and half-thickness of a closed airfoil outline at x. */
function slice(p: Profile, x: number) {
  const ys: number[] = [];
  const pts = p.pts;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) ys.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y));
  }
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  return { y: (lo + hi) / 2, half: (hi - lo) / 2 };
}

const circle = (c: Vec2, r: number) => `0\nCIRCLE\n8\n0\n10\n${c.x}\n20\n${c.y}\n40\n${r}\n`;
const line = (a: Vec2, b: Vec2) => `0\nLINE\n8\n0\n10\n${a.x}\n20\n${a.y}\n11\n${b.x}\n21\n${b.y}\n`;

/** The V-tail DXF with spar holes at 30% and 60% chord (and optionally a slot line). */
function withHoles(name: string, slot = false) {
  const text = fx(name);
  const outer = loadDxfProfile(text, 'in').profile!;
  const xs = outer.pts.map((p) => p.x);
  const x0 = Math.min(...xs);
  const w = Math.max(...xs) - x0;
  let extra = '';
  for (const f of [0.3, 0.6]) {
    const s = slice(outer, x0 + f * w);
    extra += circle({ x: x0 + f * w, y: s.y }, s.half * 0.4);
  }
  if (slot) {
    const s = slice(outer, x0 + 0.45 * w);
    extra += line({ x: x0 + 0.42 * w, y: s.y }, { x: x0 + 0.48 * w, y: s.y });
  }
  // add the new entities at the end of the ENTITIES section
  const dxf = text.replace(/\r\n/g, '\n');
  const end = dxf.indexOf('0\nENDSEC', dxf.indexOf('ENTITIES'));
  return dxf.slice(0, end) + extra + dxf.slice(end);
}

function job(): JobSettings {
  const j = defaultJob(machine, material);
  j.span = 12.07;
  j.rootFaceFromLeft = (machine.carriageSpacing - j.span) / 2;
  j.kerf = { mode: 'fixed', root: 0.0998, tip: 0.1116 };
  j.offset = { x: 4.7221, y: 0.7001 };
  return j;
}

const rootSet = loadDxfProfile(withHoles('vtail-root.dxf'), 'in');
const tipSet = loadDxfProfile(withHoles('vtail-tip.dxf'), 'in');

describe('loading several contours', () => {
  it('auto pick keeps the outline and the holes inside it', () => {
    expect(rootSet.contours).toHaveLength(3);
    expect(rootSet.contours.every((c) => c.closed !== false)).toBe(true);
    // the outer outline comes first
    const area = (p: Profile) => Math.abs(arcLoop(p).length);
    expect(area(rootSet.contours[0])).toBeGreaterThan(area(rootSet.contours[1]));
  });

  it('pairs contours by where they sit in the outline', () => {
    expect(autoPairs(rootSet.contours, tipSet.contours)).toEqual([0, 1, 2]);
    // tip holes listed the other way round still pair by position
    const swapped = [tipSet.contours[0], tipSet.contours[2], tipSet.contours[1]];
    expect(autoPairs(rootSet.contours, swapped)).toEqual([0, 2, 1]);
  });
});

describe('cutting spar holes', () => {
  const res = generateCut(rootSet.contours, tipSet.contours, job(), machine);
  const single = generateCut(rootSet.contours[0], tipSet.contours[0], job(), machine);

  it('cuts every contour with the default plan, without gaps', () => {
    expect(res.errors).toEqual([]);
    expect(res.warnings.filter((w) => w.stage !== 'path')).toEqual([]);
    expect(res.pairs).toHaveLength(3);
    expect(res.gcode.length).toBeGreaterThan(single.gcode.length);
  });

  it('adds an entry split on the outline next to each hole', () => {
    expect(res.pairs[0].sync.root.length).toBe(single.sync!.root.length + 2);
    for (const e of res.entries) {
      const hole = res.pairs[e.contour];
      const outerPt = res.splitPts.root[e.outer];
      const holePt = res.splitPts.root[hole.split0];
      // the entry split is the outline point nearest the hole
      const nearest = Math.min(...res.pairs[0].pts.root.map((p) => Math.hypot(p.x - holePt.x, p.y - holePt.y)));
      expect(Math.hypot(outerPt.x - holePt.x, outerPt.y - holePt.y)).toBeLessThan(nearest + 0.02);
    }
  });

  it('cuts in to each hole, round it, and back out the same way', () => {
    const plan = res.plan!;
    for (const pr of res.pairs.slice(1)) {
      const i = plan.steps.findIndex((s) => s.kind === 'segment' && s.seg === pr.seg0);
      const lineIn = plan.steps[i - 1];
      expect(lineIn.kind).toBe('line');
      if (lineIn.kind === 'line') expect(lineIn.speed).toBe('cut');
      const segs = plan.steps.slice(i, i + pr.sync.root.length);
      expect(segs.every((s) => s.kind === 'segment')).toBe(true);
      const lineOut = plan.steps[i + pr.sync.root.length];
      expect(lineOut.kind === 'line' && lineOut.from === (lineIn.kind === 'line' ? lineIn.to : '')).toBe(true);
    }
  });

  it('keeps hole kerf inside the hole and outline kerf outside', () => {
    for (const pr of res.pairs.slice(1)) {
      expect(pr.autoKerfSide).toBe('inside');
      expect(pr.kerfStations.every((s) => insidePolygon(s.r, pr.pts.root))).toBe(true);
    }
    expect(res.pairs[0].kerfStations.every((s) => !insidePolygon(s.r, res.pairs[0].pts.root))).toBe(true);
  });

  it('honours a chosen kerf side', () => {
    const j = job();
    j.contours.kerfSide = { 1: 'outside', 2: 'none' };
    const r = generateCut(rootSet.contours, tipSet.contours, j, machine);
    expect(r.pairs[1].kerfStations.every((s) => !insidePolygon(s.r, r.pairs[1].pts.root))).toBe(true);
    const none = r.pairs[2];
    none.kerfStations.forEach((s, i) => expect(s.r).toEqual(none.stations[Math.min(i, none.stations.length - 1)].r));
  });

  it('still works mirrored', () => {
    const j = job();
    j.transforms.flipH = true;
    const r = generateCut(rootSet.contours, tipSet.contours, j, machine);
    expect(r.errors).toEqual([]);
    expect(r.pairs[1].kerfStations.every((s) => insidePolygon(s.r, r.pairs[1].pts.root))).toBe(true);
  });

  it('skips a root contour paired to nothing, with a warning', () => {
    const j = job();
    j.contours.pairs = [0, -1, 2];
    const r = generateCut(rootSet.contours, tipSet.contours, j, machine);
    expect(r.pairs).toHaveLength(2);
    expect(r.warnings.map((w) => w.message).join(' ')).toMatch(/Root contour 2 has no tip contour/);
  });
});

describe('editing splits on another contour', () => {
  const res = generateCut(rootSet.contours, tipSet.contours, job(), machine);
  const hole = res.pairs[1];
  const ctx = { topo: res.topology!, pair: 1 };

  it('adds a split on a hole and keeps the plan valid', () => {
    const s = hole.sync.root[0] + hole.arcs.root.length / 3;
    const ed = addSplit(hole.sync, res.plan, hole.arcs, 'root', s, ctx)!;
    expect(ed.change).toEqual({ kind: 'insert', k: hole.seg0 });
    const j = job();
    j.plan = ed.plan;
    j.contours.sync = { 1: hole.syncToJob(ed.sync) };
    const r = generateCut(rootSet.contours, tipSet.contours, j, machine);
    expect(r.errors).toEqual([]);
    expect(r.pairs[1].sync.root).toHaveLength(hole.sync.root.length + 1);
    expect(r.warnings.filter((w) => w.stage === 'sequence')).toEqual([]);
  });

  it('numbers segments across contours', () => {
    const t = res.topology!;
    expect(t.contours.map((c) => c.split0)).toEqual([0, res.pairs[0].sync.root.length, res.pairs[0].sync.root.length + hole.sync.root.length]);
    // a hole's last segment wraps back to its own first split
    const last = hole.seg0 + hole.sync.root.length - 1;
    expect(segSplits(t, last)).toEqual({ start: hole.split0 + hole.sync.root.length - 1, end: hole.split0 });
  });
});

describe('open contours', () => {
  const r = loadDxfProfile(withHoles('vtail-root.dxf', true), 'in');
  const t = loadDxfProfile(withHoles('vtail-tip.dxf', true), 'in');
  const res = generateCut(r.contours, t.contours, job(), machine);
  const slot = res.pairs.find((p) => !p.closed)!;

  it('cuts a slot line in and back out, with no kerf by default', () => {
    expect(r.contours.map((c) => c.closed !== false)).toEqual([true, true, true, false]);
    expect(res.errors).toEqual([]);
    expect(res.warnings.filter((w) => w.stage === 'sequence')).toEqual([]);
    expect(slot.autoKerfSide).toBe('none');
    expect(slot.sync.root).toEqual([0, slot.arcs.root.length]);
    // forward then back
    const uses = res.plan!.steps.filter((s) => s.kind === 'segment' && s.seg === slot.seg0);
    expect(uses.map((s) => s.kind === 'segment' && s.reversed)).toEqual([false, true]);
  });

  it("can't move or remove an open contour's end splits", () => {
    expect(moveSplit(slot.sync, null, slot.arcs, 'root', 0, 0.01)).toBeNull();
  });

  it('offsets an open contour to the chosen side', () => {
    const j = job();
    const k = res.pairs.indexOf(slot);
    j.contours.kerfSide = { [slot.root]: 'left' };
    const left = generateCut(r.contours, t.contours, j, machine).pairs[k];
    j.contours.kerfSide = { [slot.root]: 'right' };
    const right = generateCut(r.contours, t.contours, j, machine).pairs[k];
    // the slot runs along x: left of travel is one side in y, right the other
    const dy = (p: typeof left) => p.kerfStations[1].r.y - p.stations[1].r.y;
    expect(Math.sign(dy(left))).toBe(-Math.sign(dy(right)));
    expect(Math.abs(dy(left))).toBeCloseTo(0.0998 / 2, 6);
  });
});
