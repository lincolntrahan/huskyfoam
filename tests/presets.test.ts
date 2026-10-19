import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kerfTableFromMeasurements, kerfTestGcode, defaultKerfTest } from '../src/core/cut/kerfTest';
import { kerfAt } from '../src/core/cut/kerfTable';
import { generateCut } from '../src/core/cut/pipeline';
import { distToSegment, type Vec2 } from '../src/core/geom/vec';
import { parseGcode } from '../src/core/gcode/parser';
import { loadDxfProfile } from '../src/core/io/loadProfile';
import { makeProject, normalizeJob, parseProject, ProjectError, validateMachine, validateMaterial } from '../src/core/io/project';
import { remapSegmentMap } from '../src/core/plan/remap';
import { defaultJob, machines, materials } from '../src/core/presets';
import type { JobSettings } from '../src/core/types';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const machine = machines.find((m) => m.id === 'shop-4axis')!;
const material = materials.find((m) => m.id === 'default-foam')!;
const rootText = fx('vtail-root.dxf');
const tipText = fx('vtail-tip.dxf');
const root = loadDxfProfile(rootText, 'in').profile!;
const tip = loadDxfProfile(tipText, 'in').profile!;

function vtailJob(patch: Partial<JobSettings> = {}): JobSettings {
  const job = defaultJob(machine, material);
  job.span = 12.07;
  job.rootFaceFromLeft = (machine.carriageSpacing - job.span) / 2;
  job.kerf = { mode: 'fixed', root: 0.0998, tip: 0.1116 };
  job.offset = { x: 4.7221, y: 0.7001 };
  job.sampling.mode = 'uniform';
  return { ...job, ...patch };
}
const run = (patch: Partial<JobSettings> = {}, m = machine) => generateCut(root, tip, vtailJob(patch), m);

/** Mean distance from a face's kerf path to its outline, over non-corner points of one segment. */
function meanOffset(res: ReturnType<typeof run>, side: 'r' | 't', seg: number) {
  const poly = side === 'r' ? res.profilePts.root : res.profilePts.tip;
  const d = (p: Vec2) => Math.min(...poly.map((a, i) => distToSegment(p, a, poly[(i + 1) % poly.length])));
  const pts = res.kerfStations.filter((s) => s.seg === seg && !s.corner).map((s) => s[side]);
  return pts.reduce((sum, p) => sum + d(p), 0) / pts.length;
}

describe('kerf table', () => {
  const table = [
    { speed: 8, kerf: 0.08 },
    { speed: 2, kerf: 0.2 },
  ];
  it('interpolates between rows (in any order) and clamps at the ends', () => {
    expect(kerfAt(table, 5).kerf).toBeCloseTo(0.14, 12);
    expect(kerfAt(table, 1)).toEqual({ kerf: 0.2, clamped: true });
    expect(kerfAt(table, 9)).toEqual({ kerf: 0.08, clamped: true });
    expect(kerfAt(table, 8)).toEqual({ kerf: 0.08, clamped: false });
  });

  it('auto kerf gives the slower tip face a wider kerf', () => {
    const res = run({ kerf: { mode: 'auto', root: 0, tip: 0 }, kerfTable: [{ speed: 1, kerf: 0.2 }, { speed: 10, kerf: 0.05 }] });
    expect(res.errors).toEqual([]);
    expect(meanOffset(res, 't', 1)).toBeGreaterThan(meanOffset(res, 'r', 1) + 0.005);
  });

  it('with a flat table it matches fixed kerf', () => {
    const flat = run({ kerf: { mode: 'auto', root: 0, tip: 0 }, kerfTable: [{ speed: 1, kerf: 0.1 }, { speed: 10, kerf: 0.1 }] });
    const fixed = run({ kerf: { mode: 'fixed', root: 0.1, tip: 0.1 } });
    expect(flat.gcode).toBe(fixed.gcode);
  });

  it('warns when the table is missing or does not cover the speeds', () => {
    expect(run({ kerf: { mode: 'auto', root: 0.1, tip: 0.1 }, kerfTable: [] }).warnings.map((w) => w.message)[0]).toMatch(/needs a kerf table/);
    const narrow = run({ kerf: { mode: 'auto', root: 0, tip: 0 }, kerfTable: [{ speed: 7, kerf: 0.1 }, { speed: 7.5, kerf: 0.1 }] });
    expect(narrow.warnings.some((w) => w.message.includes('kerf table covers'))).toBe(true);
  });
});

describe('segment overrides', () => {
  it('a slower segment takes proportionally longer', () => {
    const base = run();
    const slow = run({ segmentOverrides: { 1: { speed: material.cutSpeed / 2 } } });
    const seg1 = (r: ReturnType<typeof run>) => r.moves.filter((m) => m.step === 2).reduce((s, m) => s + m.minutes, 0); // step 2 = segment 1 in Loop
    expect(seg1(slow)).toBeCloseTo(2 * seg1(base), 9);
  });

  it('kerf 0 on a segment leaves that segment unoffset', () => {
    const res = run({ segmentOverrides: { 1: { kerf: 0 } } });
    expect(meanOffset(res, 'r', 1)).toBeLessThan(1e-9);
    expect(meanOffset(res, 'r', 2)).toBeGreaterThan(0.04);
  });

  it('follow split edits', () => {
    const o = { 1: { kerf: 0.2 }, 3: { speed: 4 } };
    expect(remapSegmentMap(o, { kind: 'insert', k: 1 })).toEqual({ 1: { kerf: 0.2 }, 2: { kerf: 0.2 }, 4: { speed: 4 } });
    expect(remapSegmentMap(o, { kind: 'remove', i: 2, n: 5 })).toEqual({ 1: { kerf: 0.2 }, 2: { speed: 4 } });
    expect(remapSegmentMap(o, { kind: 'rotate', i: 1, n: 5 })).toEqual({ 0: { kerf: 0.2 }, 2: { speed: 4 } });
  });
});

describe('corner dwell', () => {
  const on = { enabled: true, angleDeg: 30, seconds: 0.5 };
  it('pauses at every sharp corner and nowhere else', () => {
    const res = run({ dwell: on });
    // 4 tab-end corners (90°) + 2 tab/airfoil junctions at the LE (~38°); the TE junctions turn ~4°
    expect(res.stats.dwells).toBeGreaterThanOrEqual(6);
    expect(res.stats.dwells).toBeLessThanOrEqual(7); // plus possibly the start corner, entered from home
    const lines = res.gcode.split('\n').filter((l) => l.startsWith('G4'));
    expect(lines).toHaveLength(res.stats.dwells);
    expect(lines[0]).toBe('G4 P0.5');
    expect(res.stats.cutMinutes).toBeCloseTo(run().stats.cutMinutes + (res.stats.dwells * 0.5) / 60, 9);
  });

  it('uses milliseconds when the machine says so', () => {
    const res = run({ dwell: on }, { ...machine, dwellUnits: 'ms' });
    expect(res.gcode).toContain('G4 P500');
  });

  it('finds the same corners with adaptive sampling (short edges with no inner points)', () => {
    const sampling = { ...vtailJob().sampling, mode: 'adaptive' as const };
    expect(run({ dwell: on, sampling }).stats.dwells).toBe(run({ dwell: on }).stats.dwells);
  });

  it('a 100° threshold skips everything', () => {
    expect(run({ dwell: { ...on, angleDeg: 100 } }).stats.dwells).toBe(0);
  });
});

describe('wire power', () => {
  it('adds a comment and fills the header token', () => {
    const m = { ...machine, header: '{units}\nG17\nG90\nM3 S{wireWatts}' };
    const g = run({ wireWatts: 42.5 }, m).gcode.split('\n');
    expect(g[0]).toBe('(Set wire power to 42.5 W)');
    expect(g).toContain('M3 S42.5');
  });
});

describe('kerf test', () => {
  const spec = defaultKerfTest('in');
  const { gcode, plugs } = kerfTestGcode(spec, machine, material);

  it('cuts one 1" plug per speed, left to right, at that speed', () => {
    expect(plugs.map((p) => +(p.speed / material.cutSpeed).toFixed(2))).toEqual([0.4, 0.6, 0.8, 1]);
    const moves = parseGcode(gcode, machine.axes).slice(1);
    // the bottom edge of plug 1: from its corner to +1" in X
    const i = moves.findIndex((m) => Math.abs(m.left.x - (plugs[0].at.x + 1)) < 1e-9 && Math.abs(m.left.y - plugs[0].at.y) < 1e-9);
    expect(i).toBeGreaterThan(0);
    const speed = 1 * moves[i].f; // inverse time: F = v / d, d = 1"
    expect(speed).toBeCloseTo(plugs[0].speed, 4);
    // straight wire: both carriages identical
    for (const m of moves) expect(m.left).toEqual(m.right);
  });

  it('turns measurements into kerf rows', () => {
    expect(kerfTableFromMeasurements(plugs, 1, [0.9, 0.91, null, 0.93]).map((r) => +r.kerf.toFixed(4))).toEqual([0.1, 0.09, 0.07]);
  });
});

describe('projects', () => {
  it('round-trip to the exact same G-code', () => {
    const job = vtailJob({ dwell: { enabled: true, angleDeg: 30, seconds: 0.25 }, segmentOverrides: { 2: { speed: 5 } } });
    const p = makeProject({ name: 'r.dxf', text: rootText }, { name: 't.dxf', text: tipText }, job, machine, material);
    const back = parseProject(JSON.stringify(p));
    const r2 = loadDxfProfile(back.root!.text, 'in').profile!;
    const t2 = loadDxfProfile(back.tip!.text, 'in').profile!;
    expect(generateCut(r2, t2, back.job, back.machine).gcode).toBe(generateCut(root, tip, job, machine).gcode);
  });

  it('opens a job saved before newer settings existed', () => {
    const legacy = { ...vtailJob() } as Record<string, unknown>;
    delete legacy.transforms;
    delete legacy.dwell;
    delete legacy.segmentOverrides;
    delete legacy.kerfTable;
    delete legacy.wireWatts;
    legacy.kerf = { root: 0.0998, tip: 0.1116 };
    legacy.segmentKerf = {};
    const job = normalizeJob(legacy, machine, material);
    expect(job.kerf.mode).toBe('fixed');
    expect('segmentKerf' in job).toBe(false);
    expect(generateCut(root, tip, job, machine).gcode).toBe(fx('vtail-m1-uniform.nc'));
  });

  it('rejects files that are not projects', () => {
    expect(() => parseProject('{"hello": 1}')).toThrow(ProjectError);
    expect(() => parseProject('not json')).toThrow(/not valid JSON/);
    expect(() => parseProject(JSON.stringify({ format: 'huskyfoam-project', version: 2 }))).toThrow(/newer HuskyFoam/);
  });
});

describe('preset validation', () => {
  it('accepts the shipped presets', () => {
    for (const m of machines) expect(validateMachine(m)).toEqual([]);
    for (const m of materials) expect(validateMaterial(m)).toEqual([]);
  });
  it('catches bad machine settings', () => {
    const bad = { ...machine, carriageSpacing: 0, axes: { leftH: 'X', leftV: 'X', rightH: 'Z', rightV: 'a' } };
    expect(validateMachine(bad)).toEqual([
      'Carriage spacing must be greater than zero.',
      'Axis letters must be single capital letters.',
      'The four axes need four different letters.',
    ]);
  });
});
