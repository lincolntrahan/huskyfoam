import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateCut } from '../src/core/cut/pipeline';
import { arcLoop, pointAtS, sliceS, spanS } from '../src/core/geom/arc';
import { comparePaths } from '../src/core/gcode/compare';
import { chainProfile, type Profile } from '../src/core/geom/profile';
import { loadDxfProfile } from '../src/core/io/loadProfile';
import { leTePlan, loopPlan } from '../src/core/plan/templates';
import { remapRemove } from '../src/core/plan/remap';
import { defaultJob, machines, materials } from '../src/core/presets';
import { addPin, addSplit, moveSplit, removeSplit, setLoopStart } from '../src/core/sync/edit';
import { autoSync, locate } from '../src/core/sync/sync';
import type { JobSettings } from '../src/core/types';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const machine = machines.find((m) => m.id === 'shop-4axis')!;
const material = materials.find((m) => m.id === 'default-foam')!;
const root = loadDxfProfile(fx('vtail-root.dxf'), 'in').profile!;
const tip = loadDxfProfile(fx('vtail-tip.dxf'), 'in').profile!;
const arcs = { root: arcLoop(root), tip: arcLoop(tip) };

function vtailJob(): JobSettings {
  const job = defaultJob(machine, material);
  job.span = 12.07;
  job.rootFaceFromLeft = (machine.carriageSpacing - job.span) / 2;
  job.kerf = { root: 0.0998, tip: 0.1116 };
  job.offset = { x: 4.7221, y: 0.7001 };
  job.sampling.mode = 'uniform';
  return job;
}
const run = (patch: Partial<JobSettings>) => generateCut(root, tip, { ...vtailJob(), ...patch }, machine);
const loopMoves = (res: ReturnType<typeof run>) => [res.moves[0], ...res.moves.filter((m) => !m.lead)];
const auto = autoSync(root, tip, 30);

describe('arc positions', () => {
  it('slices a loop across the wrap point', () => {
    const sq = chainProfile([
      { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }], source: 'LINE' },
      { pts: [{ x: 1, y: 0 }, { x: 1, y: 1 }], source: 'LINE' },
      { pts: [{ x: 1, y: 1 }, { x: 0, y: 1 }], source: 'LINE' },
      { pts: [{ x: 0, y: 1 }, { x: 0, y: 0 }], source: 'LINE' },
    ]).profile!;
    const a = arcLoop(sq);
    expect(a.length).toBe(4);
    expect(sliceS(a, 3.5, 0.5)).toEqual([{ x: 0, y: 0.5 }, { x: 0, y: 0 }, { x: 0.5, y: 0 }]);
    expect(spanS(a, 3.5, 0.5)).toBe(1);
  });
});

describe('adding splits', () => {
  // middle of segment 2 (lower airfoil surface) on the root
  const s = (auto.root[1] + auto.root[2]) / 2;
  const edit = addSplit(auto, loopPlan(8), arcs, 'root', s)!;

  it('adds the pair at the same relative position on the tip', () => {
    expect(edit.sync.root).toHaveLength(9);
    expect(edit.sync.tip).toHaveLength(9);
    const r = locate(arcs.root, auto.root, edit.sync.root[2])!;
    const t = locate(arcs.tip, auto.tip, edit.sync.tip[2])!;
    expect(r.k).toBe(1);
    expect(t.k).toBe(1);
    expect(t.f).toBeCloseTo(r.f, 9);
  });

  it('turns the loop step into two and still cuts the same shape', () => {
    const before = run({});
    const after = run({ sync: edit.sync, plan: edit.plan });
    expect(after.errors).toEqual([]);
    expect(after.warnings).toEqual([]);
    expect(after.stats.segments).toBe(9);
    expect(comparePaths(loopMoves(after), loopMoves(before)).max).toBeLessThan(0.002);
  });
});

describe('moving, removing, re-starting', () => {
  it('will not slide a split past its neighbour', () => {
    expect(moveSplit(auto, null, arcs, 'root', 2, auto.root[4])).toBeNull();
    expect(moveSplit(auto, null, arcs, 'root', 2, (auto.root[2] + auto.root[1]) / 2)).not.toBeNull();
  });

  it('merges a back-to-back pair in the plan when a split is removed', () => {
    const add = addSplit(auto, loopPlan(8), arcs, 'root', (auto.root[1] + auto.root[2]) / 2)!;
    const rem = removeSplit(add.sync, add.plan, 2)!;
    expect(rem.note).toBeUndefined();
    const res = run({ sync: rem.sync, plan: rem.plan });
    expect(res.errors).toEqual([]);
    expect(res.stats.segments).toBe(8);
    expect(comparePaths(loopMoves(res), loopMoves(run({}))).max).toBeLessThan(1e-9);
  });

  it('resets the plan to Loop (with a note) when a removed split was used on its own', () => {
    const job = vtailJob();
    const lete = leTePlan({ splits: run({}).splitPts.root, block: { x: 4, y: 0.2, w: 14, h: 1.2 }, clearance: 0.5 });
    expect(remapRemove(lete, 3, 8)).toBeNull(); // TE corner is where the lower run-out starts
    const rem = removeSplit(auto, lete, 3)!;
    expect(rem.note).toMatch(/reset to Loop/);
    expect(generateCut(root, tip, { ...job, sync: rem.sync, plan: rem.plan }, machine).errors).toEqual([]);
  });

  it('renumbers the plan when the loop start moves', () => {
    const edit = setLoopStart(auto, loopPlan(8), 3);
    const res = run({ sync: edit.sync, plan: edit.plan });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.splitPts.root[0]).toEqual(run({}).splitPts.root[3]);
  });

  it('runs the loop the other way with the reverse template', () => {
    const fwd = run({ plan: loopPlan(8) });
    const rev = run({ plan: loopPlan(8, true) });
    expect(rev.errors).toEqual([]);
    expect(rev.warnings).toEqual([]);
    // same closed loop, opposite direction: identical shape, near-identical time
    expect(comparePaths(loopMoves(rev), loopMoves(fwd)).max).toBeLessThan(0.01);
    expect(rev.stats.cutMinutes).toBeCloseTo(fwd.stats.cutMinutes, 1);
  });
});

describe('pins', () => {
  it('puts a station exactly on both pin points', () => {
    const k = 1;
    const sRoot = auto.root[k] + 0.3 * spanS(arcs.root, auto.root[k], auto.root[k + 1]);
    const withPin = addPin(auto, arcs, 'root', sRoot)!;
    withPin.pins[0].tip = auto.tip[k] + 0.6 * spanS(arcs.tip, auto.tip[k], auto.tip[k + 1]); // drag the tip end
    const res = run({ sync: withPin, plan: null, kerf: { root: 0, tip: 0 } });
    expect(res.errors).toEqual([]);
    const off = vtailJob().offset;
    const shift = (p: { x: number; y: number }) => ({ x: p.x + off.x, y: p.y + off.y });
    const pr = shift(pointAtS(arcs.root, withPin.pins[0].root));
    const pt = shift(pointAtS(arcs.tip, withPin.pins[0].tip));
    const hit = res.stations.find((s) => Math.hypot(s.r.x - pr.x, s.r.y - pr.y) < 1e-9);
    expect(hit).toBeDefined();
    expect(hit!.t.x).toBeCloseTo(pt.x, 9);
    expect(hit!.t.y).toBeCloseTo(pt.y, 9);
  });

  it('ignores crossing pins with a warning', () => {
    const k = 1;
    const at = (side: 'root' | 'tip', f: number) => auto[side][k] + f * spanS(arcs[side], auto[side][k], auto[side][k + 1]);
    const sync = { ...auto, pins: [{ root: at('root', 0.3), tip: at('tip', 0.7) }, { root: at('root', 0.6), tip: at('tip', 0.4) }] };
    expect(run({ sync }).warnings.map((w) => w.message)).toContain('Pin 2 crosses pin 1 (their root and tip order differ) and is ignored.');
  });

  it('ignores a pin whose ends are in different segments', () => {
    const sync = { ...auto, pins: [{ root: (auto.root[1] + auto.root[2]) / 2, tip: (auto.tip[4] + auto.tip[5]) / 2 }] };
    expect(run({ sync }).warnings.map((w) => w.message)).toContain('Pin 1 is ignored: its root and tip points are in different segments.');
  });
});

describe('profile-agnostic helpers', () => {
  it('locate finds the segment and fraction', () => {
    const sq: Profile = chainProfile([
      { pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }], source: 'LINE' },
      { pts: [{ x: 2, y: 0 }, { x: 2, y: 2 }], source: 'LINE' },
      { pts: [{ x: 2, y: 2 }, { x: 0, y: 2 }], source: 'LINE' },
      { pts: [{ x: 0, y: 2 }, { x: 0, y: 0 }], source: 'LINE' },
    ]).profile!;
    const a = arcLoop(sq);
    expect(locate(a, [0, 2, 4, 6], 5)).toEqual({ k: 2, f: 0.5 });
    expect(locate(a, [6, 0, 2, 4], 7)).toEqual({ k: 0, f: 0.5 }); // segment crossing the wrap point
  });
});
