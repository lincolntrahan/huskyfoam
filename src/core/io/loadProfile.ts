import { chainProfile, transformProfile, type Profile } from '../geom/profile';
import type { Units } from '../types';
import { parseDxf } from './dxf';

export interface LoadedProfile {
  /** In the file's own coordinates, converted to the target units. */
  profile: Profile | null;
  fileUnits: Units | null;
  warnings: string[];
}

const toMm: Record<Units, number> = { in: 25.4, mm: 1 };

/** Parse a DXF into one closed profile, converted to `target` units. */
export function loadDxfProfile(text: string, target: Units): LoadedProfile {
  const dxf = parseDxf(text);
  const warnings = [...dxf.warnings];
  if (!dxf.edges.length) return { profile: null, fileUnits: dxf.units, warnings: [...warnings, 'No usable geometry in this DXF.'] };
  const chained = chainProfile(dxf.edges);
  warnings.push(...chained.warnings);
  let profile = chained.profile;
  if (!dxf.units) warnings.push(`The DXF does not say what units it uses; assuming ${target}.`);
  else if (dxf.units !== target && profile) {
    const k = toMm[dxf.units] / toMm[target];
    profile = transformProfile(profile, (p) => ({ x: p.x * k, y: p.y * k }));
  }
  return { profile, fileUnits: dxf.units, warnings };
}
