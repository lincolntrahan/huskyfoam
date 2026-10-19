import { defaultTransforms } from './cut/transform';
import type { JobSettings, MachinePreset, MaterialPreset } from './types';

// Repo presets are bundled at build time; edit the JSON in /presets and commit to change them.
const machineFiles = import.meta.glob<MachinePreset>('../../presets/machines/*.json', { eager: true, import: 'default' });
const materialFiles = import.meta.glob<MaterialPreset>('../../presets/materials/*.json', { eager: true, import: 'default' });

export const machines: MachinePreset[] = Object.values(machineFiles).sort((a, b) => a.name.localeCompare(b.name));
export const materials: MaterialPreset[] = Object.values(materialFiles).sort((a, b) => a.name.localeCompare(b.name));

/** A job with the block centered between the carriages, one third of the wire long. */
export function defaultJob(machine: MachinePreset, material: MaterialPreset): JobSettings {
  const span = machine.carriageSpacing / 3;
  return {
    rootFaceFromLeft: (machine.carriageSpacing - span) / 2,
    span,
    rootSide: 'left',
    offset: { x: 0, y: 0 },
    profile: { distance: null, inset: null },
    kerf: { mode: material.kerfMode ?? 'fixed', root: material.kerfRoot, tip: material.kerfTip },
    kerfTable: material.kerfTable ?? [],
    segmentOverrides: {},
    dwell: material.cornerDwell ?? { enabled: false, angleDeg: 30, seconds: 0.5 },
    wireWatts: material.wireWatts ?? null,
    cutSpeed: material.cutSpeed,
    sampling: { mode: 'adaptive', step: 0.04, tolerance: 0.001, maxStep: 0.1 },
    cornerSplitDeg: 30,
    block: { x: 0, y: 0, w: 0, h: 0 },
    transforms: defaultTransforms(),
    sync: null,
    plan: null,
  };
}
