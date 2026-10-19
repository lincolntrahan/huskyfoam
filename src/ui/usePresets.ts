import { useState } from 'react';
import { machines as repoMachines, materials as repoMaterials } from '../core/presets';
import type { MachinePreset, MaterialPreset } from '../core/types';

export type PresetKind = 'machine' | 'material';
/** Where a preset comes from: the team repo, this browser, or an opened project's snapshot. */
export type PresetOrigin = 'repo' | 'local' | 'project';

const KEY: Record<PresetKind, string> = { machine: 'huskyfoam:machines', material: 'huskyfoam:materials' };

function read<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or blocked: presets just won't persist */
  }
}

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'preset';

/** Repo presets (read-only) + presets saved in this browser + snapshots from opened projects. */
export function usePresets() {
  const [local, setLocal] = useState({ machine: read<MachinePreset>(KEY.machine), material: read<MaterialPreset>(KEY.material) });
  const [project, setProject] = useState<{ machine: MachinePreset[]; material: MaterialPreset[] }>({ machine: [], material: [] });

  const origin = (kind: PresetKind, id: string): PresetOrigin =>
    local[kind].some((p) => p.id === id) ? 'local' : project[kind].some((p) => p.id === id) ? 'project' : 'repo';

  /** Save to this browser. Repo/project presets are saved as a new local copy. Returns the saved id. */
  function save<K extends PresetKind>(kind: K, p: K extends 'machine' ? MachinePreset : MaterialPreset, asCopy = false): string {
    const list = local[kind] as (MachinePreset | MaterialPreset)[];
    const isLocal = list.some((x) => x.id === p.id);
    const id = isLocal && !asCopy ? p.id : `local-${slug(p.name)}-${Date.now().toString(36)}`;
    const next = isLocal && !asCopy ? list.map((x) => (x.id === id ? { ...p, id } : x)) : [...list, { ...p, id }];
    write(KEY[kind], next);
    setLocal((l) => ({ ...l, [kind]: next }));
    return id;
  }

  function remove(kind: PresetKind, id: string) {
    const next = (local[kind] as { id: string }[]).filter((x) => x.id !== id);
    write(KEY[kind], next);
    setLocal((l) => ({ ...l, [kind]: next }));
  }

  /**
   * Make a project's snapshot selectable. If an existing preset is identical it's reused;
   * otherwise the snapshot is listed as "(from project)". Returns the id to select.
   */
  function adopt<K extends PresetKind>(kind: K, p: K extends 'machine' ? MachinePreset : MaterialPreset): string {
    const all = [...(kind === 'machine' ? repoMachines : repoMaterials), ...local[kind], ...project[kind]] as { id: string }[];
    const same = all.find((x) => JSON.stringify(x) === JSON.stringify(p));
    if (same) return same.id;
    const id = `project-${slug(p.name)}-${Date.now().toString(36)}`;
    setProject((s) => ({ ...s, [kind]: [...s[kind], { ...p, id, name: `${p.name} (from project)` }] }));
    return id;
  }

  return {
    machines: [...repoMachines, ...local.machine, ...project.machine],
    materials: [...repoMaterials, ...local.material, ...project.material],
    origin,
    save,
    remove,
    adopt,
  };
}
