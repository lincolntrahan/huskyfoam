import { readFileSync } from 'node:fs';
import { testMachine } from './testMachine';
import { describe, expect, it } from 'vitest';
import { generateCut } from '../src/core/cut/pipeline';
import { chainProfile, type Profile } from '../src/core/geom/profile';
import { loadDxfProfile } from '../src/core/io/loadProfile';
import { bridgeGap, insertOutAndBack, insertPointOnLine, moveStep, removeStep, setSpeed } from '../src/core/plan/edit';
import { HOME, splitId, type CutPlan } from '../src/core/plan/model';
import { leTePlan, loopPlan } from '../src/core/plan/templates';
import { defaultJob, materials } from '../src/core/presets';
import type { JobSettings } from '../src/core/types';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const machine = testMachine;
const material = materials.find((m) => m.id === 'default-foam')!;
const root = loadDxfProfile(fx('vtail-root.dxf'), 'in').profile!;
const tip = loadDxfProfile(fx('vtail-tip.dxf'), 'in').profile!;

/** Same V-tail job as the M1 sanity check. */
function vtailJob(mode: 'uniform' | 'adaptive' = 'uniform'): JobSettings {
  const job = defaultJob(machine, material);
  job.span = 12.07;
  job.rootFaceFromLeft = (machine.carriageSpacing - job.span) / 2;
  job.kerf = { mode: 'fixed', root: 0.0998, tip: 0.1116 };
  job.offset = { x: 4.7221, y: 0.7001 };
  job.sampling.mode = mode;
  return job;
}

/** Block = bounding box of both (positioned) profiles plus a margin. */
function fitBlock(job: JobSettings, margin = 0.1) {
  const pts = [...root.pts, ...tip.pts].map((p) => ({ x: p.x + job.offset.x, y: p.y + job.offset.y }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs) - margin;
  const y = Math.min(...ys) - margin;
  return { x, y, w: Math.max(...xs) + margin - x, h: Math.max(...ys) + margin - y };
}

const rootSplitPts = (job: JobSettings) => {
  const res = generateCut(root, tip, job, machine);
  return res.splitPts.root;
};

describe('Loop template', () => {
  for (const mode of ['uniform', 'adaptive'] as const) {
    it(`reproduces M1's G-code byte-for-byte (${mode})`, () => {
      const job = vtailJob(mode);
      const fromNull = generateCut(root, tip, job, machine);
      const explicit = generateCut(root, tip, { ...job, plan: loopPlan(8) }, machine);
      expect(fromNull.gcode).toBe(fx(`vtail-m1-${mode}.nc`));
      expect(explicit.gcode).toBe(fromNull.gcode);
    });
  }
});

describe('LE→TE template', () => {
  const job = vtailJob();
  job.block = fitBlock(job);
  const plan = leTePlan({ splits: rootSplitPts(job), block: job.block, clearance: 0.5 });
  const res = generateCut(root, tip, { ...job, plan }, machine);

  it('has no gaps and exports', () => {
    expect(res.errors).toEqual([]);
    expect(res.gcode).not.toBe('');
  });

  it('cuts every airfoil segment exactly once; only the tab end faces are skipped', () => {
    // segments 4 and 8 are the vertical tab ends, which sit outside the block
    expect(res.warnings.map((w) => w.message).filter((m) => m.includes('cut'))).toEqual([
      'Segment 4 is never cut.',
      'Segment 8 is never cut.',
    ]);
  });

  it('routes every jog around the block', () => {
    expect(res.warnings.some((w) => w.message.includes('jog through'))).toBe(false);
    expect(res.warnings.some((w) => w.message.includes('inside the foam block'))).toBe(false);
  });

  it('cuts both surfaces from the LE toward the TE', () => {
    const upper = plan.steps.filter((s) => s.kind === 'segment' && s.reversed).length;
    const lower = plan.steps.filter((s) => s.kind === 'segment' && !s.reversed).length;
    expect([upper, lower]).toEqual([3, 3]);
  });
});

describe('out-and-back', () => {
  it('returns to the same kerf point it left from', () => {
    const job = vtailJob();
    // TE of a sharp profile: split 3 on the V-tail is the bottom corner of the TE tab end
    const plan = insertOutAndBack(loopPlan(8), 3, { r: { x: 20, y: 0.7 }, t: { x: 20, y: 0.7 } }, 8);
    const res = generateCut(root, tip, { ...job, plan }, machine);
    expect(res.errors).toEqual([]);
    const outStep = plan.steps.findIndex((s) => s.kind === 'line' && s.to.startsWith('p'));
    const leaving = res.path.filter((p) => p.step === outStep - 1).at(-1)!;
    const returned = res.path.filter((p) => p.step === outStep + 1).at(-1)!;
    expect(returned.r).toEqual(leaving.r);
    expect(returned.t).toEqual(leaving.t);
    expect(res.warnings.filter((w) => w.message.includes('cut'))).toEqual([]);
  });
});

describe('checks', () => {
  it('flags a jog through the foam block', () => {
    const job = vtailJob();
    job.block = fitBlock(job);
    const plan = setSpeed(loopPlan(8), 0, 'jog'); // home -> LE corner is inside the block
    const res = generateCut(root, tip, { ...job, plan }, machine);
    expect(res.warnings.some((w) => w.message.startsWith('Step 1 is a jog through the foam block'))).toBe(true);
  });

  it('blocks export on a gap, and bridging fixes it', () => {
    const job = vtailJob();
    const gapped = removeStep(loopPlan(8), 3); // drop segment 3
    const bad = generateCut(root, tip, { ...job, plan: gapped }, machine);
    expect(bad.ok).toBe(false);
    expect(bad.gcode).toBe('');
    expect(bad.gaps).toHaveLength(1);

    const fixed = bridgeGap(gapped, bad.gaps[0].before, 'jog', 8);
    const good = generateCut(root, tip, { ...job, plan: fixed }, machine);
    expect(good.errors).toEqual([]);
    expect(good.warnings.map((w) => w.message)).toContain('Segment 3 is never cut.');
  });

  it('reports a plan that does not return home', () => {
    const plan = loopPlan(8);
    plan.steps.pop();
    const res = generateCut(root, tip, { ...vtailJob(), plan }, machine);
    expect(res.errors[0]).toMatch(/does not end at home/);
  });

  it('reports a plan that refers to a segment the profiles do not have', () => {
    const res = generateCut(root, tip, { ...vtailJob(), plan: loopPlan(9) }, machine);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/segment 9, but the profiles have 8/);
  });
});

describe('reversed segments', () => {
  it('are the exact reverse of forward ones', () => {
    const sq: Profile = chainProfile([
      { pts: [{ x: 5, y: 2 }, { x: 7, y: 2 }], source: 'LINE' },
      { pts: [{ x: 7, y: 2 }, { x: 7, y: 4 }], source: 'LINE' },
      { pts: [{ x: 7, y: 4 }, { x: 5, y: 4 }], source: 'LINE' },
      { pts: [{ x: 5, y: 4 }, { x: 5, y: 2 }], source: 'LINE' },
    ]).profile!;
    const job: JobSettings = { ...defaultJob(machine, material), kerf: { mode: 'fixed', root: 0, tip: 0 } };
    job.sampling = { ...job.sampling, mode: 'uniform', step: 0.25 };
    const pts = { [HOME]: { kind: 'home' as const }, [splitId(0)]: { kind: 'split' as const, split: 0 }, [splitId(1)]: { kind: 'split' as const, split: 1 } };
    const fwd: CutPlan = {
      points: pts,
      template: 'custom',
      steps: [
        { id: 'l1', kind: 'line', from: HOME, to: splitId(0), speed: 'jog' },
        { id: 'g1', kind: 'segment', seg: 0, reversed: false },
        { id: 'l2', kind: 'line', from: splitId(1), to: HOME, speed: 'jog' },
      ],
    };
    const rev: CutPlan = {
      points: pts,
      template: 'custom',
      steps: [
        { id: 'l1', kind: 'line', from: HOME, to: splitId(1), speed: 'jog' },
        { id: 'g1', kind: 'segment', seg: 0, reversed: true },
        { id: 'l2', kind: 'line', from: splitId(0), to: HOME, speed: 'jog' },
      ],
    };
    const a = generateCut(sq, sq, { ...job, plan: fwd }, machine).path.slice(1, -1);
    const b = generateCut(sq, sq, { ...job, plan: rev }, machine).path.slice(1, -1);
    expect(a.length).toBe(9); // 2" edge at 0.25 spacing
    expect(b.map((p) => p.r)).toEqual(a.map((p) => p.r).reverse());
  });
});

describe('plan edits', () => {
  it('splits a line at a new point without changing the route ends', () => {
    const p = insertPointOnLine(loopPlan(8), 0, { x: 1, y: 1 });
    expect(p.steps).toHaveLength(11);
    const [l1, l2] = p.steps as { from: string; to: string }[];
    expect([l1.from, l1.to, l2.from, l2.to]).toEqual([HOME, 'p1', 'p1', splitId(0)]);
    expect(p.template).toBe('custom');
  });

  it('moves steps up and down', () => {
    const p = moveStep(loopPlan(8), 1, 1);
    expect(p.steps.slice(1, 3).map((s) => (s.kind === 'segment' ? s.seg : -1))).toEqual([1, 0]);
  });
});

describe('problem stages', () => {
  it('tags each problem with the job step it belongs to', () => {
    const job = vtailJob();
    const gapped = generateCut(root, tip, { ...job, plan: removeStep(loopPlan(8), 3) }, machine);
    expect(gapped.errorStages).toEqual(['sequence']);
    expect(gapped.warnings.find((w) => w.message.includes('never cut'))?.stage).toBe('sequence');

    const tiny = { ...machine, travel: { x: [0, 1] as [number, number], y: [0, 1] as [number, number] } };
    expect(generateCut(root, tip, job, tiny).warnings.find((w) => w.message.includes('travel'))?.stage).toBe('path');

    expect(generateCut(root, tip, { ...job, span: 0 }, machine).errorStages).toEqual(['setup']);
    const tri = chainProfile([
      { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }], source: 'LINE' },
      { pts: [{ x: 1, y: 0 }, { x: 0, y: 1 }], source: 'LINE' },
      { pts: [{ x: 0, y: 1 }, { x: 0, y: 0 }], source: 'LINE' },
    ]).profile!;
    expect(generateCut(root, tri, job, machine).errorStages).toEqual(['segment']);
  });
});
