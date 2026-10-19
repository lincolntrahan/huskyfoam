import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateCut, safeHeight, type CutResult } from '../src/core/cut/pipeline';
import type { Profile } from '../src/core/geom/profile';
import type { Vec2 } from '../src/core/geom/vec';
import { loadDxfProfile } from '../src/core/io/loadProfile';
import { emptyPlan, type CutPlan } from '../src/core/plan/model';
import { applyPairTemplate, insertJog, insertSegment, moveGroupTo, moveStepTo, removeGroup, sequenceAll } from '../src/core/plan/tree';
import { defaultJob, materials } from '../src/core/presets';
import { addSplit } from '../src/core/sync/edit';
import type { JobSettings } from '../src/core/types';
import { testMachine } from './testMachine';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const machine = testMachine;
const material = materials.find((m) => m.id === 'default-foam')!;

/** Thickness centre and half-thickness of a closed airfoil outline at x. */
function slice(p: Profile, x: number) {
  const ys: number[] = [];
  for (let i = 0; i < p.pts.length; i++) {
    const a = p.pts[i];
    const b = p.pts[(i + 1) % p.pts.length];
    if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) ys.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y));
  }
  return { y: (Math.min(...ys) + Math.max(...ys)) / 2, half: (Math.max(...ys) - Math.min(...ys)) / 2 };
}
const circle = (c: Vec2, r: number) => `0\nCIRCLE\n8\n0\n10\n${c.x}\n20\n${c.y}\n40\n${r}\n`;
function withHoles(name: string) {
  const outer = loadDxfProfile(fx(name), 'in').profile!;
  const xs = outer.pts.map((p) => p.x);
  const x0 = Math.min(...xs);
  const w = Math.max(...xs) - x0;
  let extra = '';
  for (const f of [0.6, 0.3]) {
    const s = slice(outer, x0 + f * w);
    extra += circle({ x: x0 + f * w, y: s.y }, s.half * 0.4);
  }
  const dxf = fx(name).replace(/\r\n/g, '\n');
  const end = dxf.indexOf('0\nENDSEC', dxf.indexOf('ENTITIES'));
  return dxf.slice(0, end) + extra + dxf.slice(end);
}
const root = loadDxfProfile(withHoles('vtail-root.dxf'), 'in').contours;
const tip = loadDxfProfile(withHoles('vtail-tip.dxf'), 'in').contours;

function job(plan: CutPlan | null): JobSettings {
  const j = defaultJob(machine, material);
  j.span = 12.07;
  j.rootFaceFromLeft = (machine.carriageSpacing - j.span) / 2;
  j.kerf = { mode: 'fixed', root: 0.0998, tip: 0.1116 };
  j.offset = { x: 4.7221, y: 0.7001 };
  j.block = { x: 4.5, y: 0.5, w: 14, h: 1.4 };
  j.plan = plan;
  return j;
}
const cut = (plan: CutPlan | null) => generateCut(root, tip, job(plan), machine);
const base = cut(emptyPlan());
const topo = base.topology!;
/** Inner pairs in order along the chord (by their start split's x). */
const order = (r: CutResult) =>
  r.pairs
    .map((pr, i) => ({ i, x: r.splitPts.root[pr.split0].x }))
    .filter((p) => p.i > 0)
    .sort((a, b) => a.x - b.x)
    .map((p) => p.i);

describe('starting empty', () => {
  it('reports nothing sequenced, and blocks export', () => {
    expect(base.ok).toBe(false);
    expect(base.errors.join(' ')).toMatch(/Nothing is sequenced/);
    expect(base.gcode).toBe('');
  });

  it('starts each hole at its highest point', () => {
    for (const pr of base.pairs.slice(1)) {
      const start = base.splitPts.root[pr.split0];
      expect(start.y).toBeCloseTo(Math.max(...pr.pts.root.map((p) => p.y)), 9);
    }
  });

  it("doesn't add old-style entry splits to the outline", () => {
    const legacy = cut(null);
    expect(base.pairs[0].sync.root.length).toBe(legacy.pairs[0].sync.root.length - 2);
  });
});

describe('Sequence all', () => {
  const plan = sequenceAll(topo, order(base));
  const res = cut(plan);

  it('cuts everything with no gaps and returns home', () => {
    expect(res.errors).toEqual([]);
    expect(res.gaps).toEqual([]);
    expect(res.warnings.filter((w) => w.stage === 'sequence')).toEqual([]);
    expect(res.gcode.length).toBeGreaterThan(0);
  });

  it('puts the holes first (front to back), then the outline, each in its own folder', () => {
    const groups = plan.groups!;
    expect(groups.map((g) => g.pair)).toEqual([...order(base), 0]);
    expect(groups.map((g) => g.name)).toEqual(groups.map((g) => `Pair ${g.pair! + 1} · Loop`));
    // folder runs are contiguous, in that order
    const runs = plan.steps.filter((s, i) => s.group && s.group !== plan.steps[i - 1]?.group).map((s) => s.group);
    expect(runs).toEqual(groups.map((g) => g.id));
    // ends with a jog home
    const last = plan.steps[plan.steps.length - 1];
    expect(last.kind === 'jog' && last.to === 'home').toBe(true);
  });

  it('plunges straight down into each hole from the safe height and comes back up the same way', () => {
    const safe = safeHeight(job(plan), res.pairs);
    for (const g of plan.groups!.filter((x) => x.pair! > 0)) {
      const idx = plan.steps.map((s, i) => (s.group === g.id ? i : -1)).filter((i) => i >= 0);
      const down = res.path.filter((p) => p.step === idx[1]); // the cut line above -> start
      const prev = res.path[res.path.indexOf(down[0]) - 1];
      expect(prev.r.y).toBeCloseTo(safe, 9);
      expect(down[0].r.x).toBeCloseTo(prev.r.x, 9);
      expect(down[0].t.x).toBeCloseTo(prev.t.x, 9);
      expect(down[0].speed).toBe('cut');
      const up = res.path.filter((p) => p.step === idx[idx.length - 1]);
      expect(up[up.length - 1].r).toEqual(prev.r);
    }
  });

  it('jogs between folders over the block, never through it', () => {
    expect(res.warnings.map((w) => w.message).join(' ')).not.toMatch(/jog through the foam/);
    const jogs = res.path.filter((p) => p.speed === 'jog');
    expect(jogs.length).toBeGreaterThan(0);
  });
});

describe('templates per pair', () => {
  it('replaces a pair’s folder in place', () => {
    const plan = sequenceAll(topo, order(base));
    const firstHole = plan.groups![0];
    const before = plan.steps.findIndex((s) => s.group === firstHole.id);
    const next = applyPairTemplate(plan, topo, firstHole.pair!, 'loop-reverse', plan.steps.length);
    const g = next.groups!.find((x) => x.pair === firstHole.pair)!;
    expect(g.name).toBe(`Pair ${firstHole.pair! + 1} · Loop (reverse)`);
    expect(next.steps.findIndex((s) => s.group === g.id)).toBe(before);
    expect(next.groups!).toHaveLength(plan.groups!.length);
    const res = cut(next);
    expect(res.errors).toEqual([]);
    expect(res.gaps).toEqual([]);
  });

  it('cuts one pair at a time; the rest stay unsequenced', () => {
    const one = applyPairTemplate(emptyPlan(), topo, 1, 'loop', 0);
    const res = cut(one);
    expect(res.errors.filter((e) => /isn't sequenced/.test(e))).toHaveLength(2);
    expect(res.gaps).toEqual([]);
  });

  it('LE→TE on the outline, with holes first', () => {
    let plan = applyPairTemplate(emptyPlan(), topo, order(base)[0], 'loop', 0);
    plan = applyPairTemplate(plan, topo, order(base)[1], 'loop', plan.steps.length);
    const outer = base.splitPts.root.slice(0, base.pairs[0].sync.root.length);
    plan = applyPairTemplate(plan, topo, 0, 'le-te', plan.steps.length, { splits: outer, block: job(null).block, clearance: 0.5 });
    const res = cut(plan);
    expect(res.errors).toEqual([]);
    expect(res.gaps).toEqual([]);
  });
});

describe('editing the tree', () => {
  const plan = sequenceAll(topo, order(base));

  it('moves a folder as a whole, and the cut still has no gaps', () => {
    const outline = plan.groups!.find((g) => g.pair === 0)!;
    const moved = moveGroupTo(plan, outline.id, 0);
    expect(moved.steps[0].group).toBe(outline.id);
    expect(cut(moved).gaps).toEqual([]);
  });

  it('moves a step into another folder', () => {
    const [a, b] = plan.groups!;
    const i = plan.steps.findIndex((s) => s.group === a.id);
    const j = plan.steps.findIndex((s) => s.group === b.id);
    const moved = moveStepTo(plan, i, j + 1, b.id);
    expect(moved.steps[j].group).toBe(b.id);
  });

  it('inserts a jog and a segment at a position, in the folder above it', () => {
    const g = plan.groups![0];
    const end = plan.steps.map((s) => s.group).lastIndexOf(g.id) + 1;
    const withJog = insertJog(plan, end, 'home');
    expect(withJog.steps[end]).toMatchObject({ kind: 'jog', to: 'home', group: g.id });
    const withSeg = insertSegment(plan, end, 0, false);
    expect(withSeg.steps[end]).toMatchObject({ kind: 'segment', seg: 0, group: g.id });
  });

  it('deletes a folder with its steps, or keeps them at the top level', () => {
    const g = plan.groups![0];
    const n = plan.steps.filter((s) => s.group === g.id).length;
    expect(removeGroup(plan, g.id, true).steps).toHaveLength(plan.steps.length - n);
    const kept = removeGroup(plan, g.id, false);
    expect(kept.steps).toHaveLength(plan.steps.length);
    expect(kept.steps.some((s) => s.group === g.id)).toBe(false);
  });

  it('keeps plunge points on their split when a split is added before them', () => {
    const outline = base.pairs[0];
    const ed = addSplit(outline.sync, plan, outline.arcs, 'root', (outline.sync.root[1] + outline.sync.root[2]) / 2, { topo, pair: 0 })!;
    const j = job(ed.plan);
    j.sync = outline.syncToJob(ed.sync);
    const res = generateCut(root, tip, j, machine);
    expect(res.errors).toEqual([]);
    expect(res.gaps).toEqual([]);
  });
});

describe('step colours', () => {
  it('ties each step to its pair (or none for the jog home)', async () => {
    const { stepPair } = await import('../src/core/plan/tree');
    const plan = sequenceAll(topo, order(base));
    plan.steps.forEach((s, i) => {
      const g = plan.groups!.find((x) => x.id === s.group);
      expect(stepPair(plan, topo, i)).toBe(g ? g.pair : -1);
    });
  });
});
