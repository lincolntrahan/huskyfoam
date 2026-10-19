import { profilePlanes } from '../cut/pipeline';
import { defaultLayout } from '../cut/placement';
import { defaultTransforms } from '../cut/transform';
import { defaultJob } from '../presets';
import type { JobSettings, MachinePreset, MaterialPreset } from '../types';

/** A DXF as loaded, kept verbatim so a project reopens exactly. */
export interface SourceFile {
  name: string;
  text: string;
}

/** `.hfoam.json`: everything needed to reproduce a cut. */
export interface ProjectFile {
  format: 'huskyfoam-project';
  version: 1;
  savedAt: string;
  root: SourceFile | null;
  tip: SourceFile | null;
  job: JobSettings;
  /** Snapshots, so the project cuts the same even if the presets change later. */
  machine: MachinePreset;
  material: MaterialPreset;
}

export function makeProject(root: SourceFile | null, tip: SourceFile | null, job: JobSettings, machine: MachinePreset, material: MaterialPreset): ProjectFile {
  return { format: 'huskyfoam-project', version: 1, savedAt: new Date().toISOString(), root, tip, job, machine, material };
}

/**
 * Fill in anything an older (or hand-edited) job is missing, using today's defaults. Keeps the
 * app from crashing on projects saved before a setting existed.
 */
export function normalizeJob(job: Partial<JobSettings> & Record<string, unknown>, machine: MachinePreset, material: MaterialPreset): JobSettings {
  const d = defaultJob(machine, material);
  const legacyKerf = job.segmentKerf as Record<number, number> | undefined; // before per-segment speed existed
  const t = (job.transforms ?? {}) as Partial<JobSettings['transforms']>;
  const out: JobSettings = {
    ...d,
    ...job,
    kerf: { ...d.kerf, ...(job.kerf ?? {}) },
    sampling: { ...d.sampling, ...(job.sampling ?? {}) },
    block: { ...d.block, ...(job.block ?? {}) },
    profile: { ...d.profile, ...(job.profile ?? {}) },
    selection: { ...d.selection, ...(job.selection ?? {}) },
    dwell: { ...d.dwell, ...(job.dwell ?? {}) },
    transforms: {
      ...defaultTransforms(),
      ...t,
      root: { ...defaultTransforms().root, ...(t.root ?? {}) },
      tip: { ...defaultTransforms().tip, ...(t.tip ?? {}) },
    },
    segmentOverrides:
      job.segmentOverrides ?? Object.fromEntries(Object.entries(legacyKerf ?? {}).map(([k, v]) => [k, { kerf: v }])),
    kerfTable: job.kerfTable ?? d.kerfTable,
    wireWatts: job.wireWatts === undefined ? d.wireWatts : job.wireWatts,
    sync: job.sync ?? null,
    contours: { ...d.contours, ...(job.contours ?? {}) },
    plan: job.plan ?? null,
  };
  delete (out as unknown as Record<string, unknown>).segmentKerf;
  if (job.layout === undefined) {
    // saved before automatic placement: keep the profiles where they were along the wire and the block size
    const planes = profilePlanes(out);
    out.layout = {
      ...defaultLayout(machine, planes.distance),
      profileFromLeft: Math.min(planes.zr, planes.zt),
      block: { w: out.block.w, h: out.block.h, len: out.span },
    };
    out.profile = { distance: planes.distance, inset: null };
  }
  return out;
}

export class ProjectError extends Error {}

export function parseProject(text: string): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectError('This file is not valid JSON, so it is not a HuskyFoam project.');
  }
  const p = raw as Partial<ProjectFile>;
  if (p?.format !== 'huskyfoam-project') throw new ProjectError('This file is not a HuskyFoam project (.hfoam.json).');
  if (p.version !== 1) throw new ProjectError(`This project was saved by a newer HuskyFoam (format version ${String(p.version)}). Update the app to open it.`);
  if (!p.machine || !p.material || !p.job) throw new ProjectError('This project is missing its machine, material or job settings.');
  return { ...(p as ProjectFile), job: normalizeJob(p.job as JobSettings & Record<string, unknown>, p.machine, p.material) };
}

/** Problems that would make a machine preset unusable (empty = fine). */
export function validateMachine(m: MachinePreset): string[] {
  const e: string[] = [];
  if (!m.name?.trim()) e.push('Name is required.');
  if (!(m.carriageSpacing > 0)) e.push('Carriage spacing must be greater than zero.');
  if (!(m.maxSpeed > 0)) e.push('Max speed must be greater than zero.');
  if (!(m.jogSpeed > 0)) e.push('Jog speed must be greater than zero.');
  if (!(m.travel.x[1] > m.travel.x[0]) || !(m.travel.y[1] > m.travel.y[0])) e.push('Travel limits need max greater than min.');
  const letters = Object.values(m.axes);
  if (letters.some((l) => !/^[A-Z]$/.test(l))) e.push('Axis letters must be single capital letters.');
  if (new Set(letters).size !== 4) e.push('The four axes need four different letters.');
  if (new Set(m.axisOrder).size !== 4) e.push('Axis order must list each axis once.');
  if (!(m.decimals >= 0 && m.decimals <= 8)) e.push('Decimals must be between 0 and 8.');
  return e;
}

export function validateMaterial(m: MaterialPreset): string[] {
  const e: string[] = [];
  if (!m.name?.trim()) e.push('Name is required.');
  if (!(m.cutSpeed > 0)) e.push('Cut speed must be greater than zero.');
  if (!(m.kerfRoot >= 0) || !(m.kerfTip >= 0)) e.push('Kerf cannot be negative.');
  if (m.wireWatts !== undefined && !(m.wireWatts >= 0)) e.push('Wire power cannot be negative.');
  if (m.kerfTable?.some((p) => !(p.speed > 0) || !(p.kerf >= 0))) e.push('Kerf table rows need a positive speed and a kerf of 0 or more.');
  return e;
}
