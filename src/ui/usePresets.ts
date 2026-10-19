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

/** Short stable hash of a string (FNV-1a), for ids. */
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

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
   * Make a project's snapshot selectable. If an existing preset has the same settings it's
   * reused; otherwise the snapshot is listed as "(from project)". With `current` (restoring this
   * browser's last session) a team or browser preset with the same id wins, so edits to it apply.
   * Returns the id to select.
   */
  function adopt<K extends PresetKind>(kind: K, p: K extends 'machine' ? MachinePreset : MaterialPreset, current = false): string {
    const own = [...(kind === 'machine' ? repoMachines : repoMaterials), ...local[kind]] as { id: string; name: string }[];
    if (current && own.some((x) => x.id === p.id)) return p.id;
    const all = [...own, ...project[kind]] as { id: string; name: string }[];
    const settings = (x: { id: string; name: string }) => JSON.stringify({ ...x, id: '', name: '' });
    const same = all.find((x) => settings(x) === settings(p));
    if (same) return same.id;
    const base = p.name.replace(/( \(from project\))+$/, '');
    // the id comes from the settings, so adopting the same snapshot twice lists it once
    const id = `project-${slug(base)}-${hash(settings(p))}`;
    setProject((s) => (s[kind].some((x) => x.id === id) ? s : { ...s, [kind]: [...s[kind], { ...p, id, name: `${base} (from project)` }] }));
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
