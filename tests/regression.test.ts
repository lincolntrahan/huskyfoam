import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateCut } from '../src/core/cut/pipeline';
import { comparePaths } from '../src/core/gcode/compare';
import { parseGcode } from '../src/core/gcode/parser';
import { loadDxfProfile } from '../src/core/io/loadProfile';
import { defaultJob, machines, materials } from '../src/core/presets';

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/*
 * Sanity check against a DevFoam export of the same part. The reference previews correctly in
 * DevFoam but does not run perfectly on our machine yet, so it is treated as "same ballpark",
 * not ground truth; the exact math is covered by the unit tests.
 *
 * Settings were back-solved by least squares (36" carriage spacing):
 *   block span 12.07 centered, kerf 0.0998 root / 0.1116 tip, part offset (4.7221, 0.7001), 200 mm/min.
 */
function vtail(mode: 'uniform' | 'adaptive' = 'uniform') {
  const machine = machines.find((m) => m.id === 'shop-4axis')!;
  const material = materials.find((m) => m.id === 'default-foam')!;
  const job = defaultJob(machine, material);
  job.span = 12.07;
  job.rootFaceFromLeft = (machine.carriageSpacing - job.span) / 2;
  job.kerf = { mode: 'fixed', root: 0.0998, tip: 0.1116 };
  job.offset = { x: 4.7221, y: 0.7001 };
  job.sampling.mode = mode;
  const root = loadDxfProfile(fx('vtail-root.dxf'), machine.units).profile!;
  const tip = loadDxfProfile(fx('vtail-tip.dxf'), machine.units).profile!;
  return { machine, res: generateCut(root, tip, job, machine) };
}

const reference = () => parseGcode(fx('vtail-devfoam.nc'), machines.find((m) => m.id === 'shop-4axis')!.axes);

describe('V-tail sanity check vs DevFoam', () => {
  for (const mode of ['uniform', 'adaptive'] as const) {
    it(`carriage paths are close to DevFoam's (${mode} sampling)`, () => {
      const { res } = vtail(mode);
      expect(res.errors).toEqual([]);
      expect(res.stats.segments).toBe(8);
      const ours = [res.moves[0], ...res.moves.filter((m) => !m.lead)];
      const diff = comparePaths(ours, reference().slice(1, -1));
      expect(diff.rms).toBeLessThan(0.005);
      expect(diff.p95).toBeLessThan(0.01);
      expect(diff.max).toBeLessThan(0.025); // worst points are corner arcs; DevFoam rounds coarser
    });
  }

  it('total cut time is within 1% of DevFoam', () => {
    const { res } = vtail();
    const refMinutes = reference()
      .filter((m) => !m.rapid)
      .reduce((s, m) => s + 1 / m.f, 0);
    expect(Math.abs(res.stats.cutMinutes - refMinutes) / refMinutes).toBeLessThan(0.01);
  });

  it('writes the same header, home and footer as DevFoam', () => {
    const lines = vtail().res.gcode.trim().split('\n');
    const ref = fx('vtail-devfoam.nc').trim().split(/\r?\n/);
    expect(lines.slice(0, 7)).toEqual(ref.slice(0, 7));
    expect(lines[lines.length - 1]).toBe('M5');
  });

  it('adaptive sampling uses far fewer moves than uniform', () => {
    expect(vtail('adaptive').res.moves.length).toBeLessThan(vtail('uniform').res.moves.length * 0.7);
  });
});
