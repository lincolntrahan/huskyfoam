import { chainProfile, type Profile } from '../geom/profile';
import type { Vec2 } from '../geom/vec';
import type { Units } from '../types';
import { parseDxf, type DxfText, type Edge } from './dxf';

export interface LoadedProfile {
  /** The outline to cut, in the target units (null if the chosen entities don't close). */
  profile: Profile | null;
  fileUnits: Units | null;
  warnings: string[];
  /** Every entity in the file (target units), for picking on the Import page. */
  edges: Edge[];
  /** Text in the file (target units): shown, never cut. */
  texts: DxfText[];
  /** Entities in use: the given selection, or the automatic pick. */
  selected: number[];
  /** Entities that ended up in the outline (a subset of `selected`). */
  used: number[];
}

const toMm: Record<Units, number> = { in: 25.4, mm: 1 };

/**
 * Parse a DXF into one closed profile, converted to `target` units.
 * `selection` limits it to those entity indices; null = automatic (the largest closed outline).
 */
export function loadDxfProfile(text: string, target: Units, selection: number[] | null = null): LoadedProfile {
  const dxf = parseDxf(text);
  const warnings = [...dxf.warnings];
  const k = dxf.units && dxf.units !== target ? toMm[dxf.units] / toMm[target] : 1;
  const sc = (p: Vec2) => (k === 1 ? p : { x: p.x * k, y: p.y * k });
  const edges = dxf.edges.map((e) => ({ ...e, pts: e.pts.map(sc) }));
  const texts = dxf.texts.map((t) => ({ ...t, at: sc(t.at), height: t.height * k }));
  if (!dxf.units) warnings.push(`The DXF does not say what units it uses; assuming ${target}.`);
  const base = { fileUnits: dxf.units, edges, texts };
  if (!edges.length) return { ...base, profile: null, selected: [], used: [], warnings: [...warnings, 'No usable geometry in this DXF.'] };

  const selected = selection ? selection.filter((i) => i >= 0 && i < edges.length) : edges.map((_, i) => i);
  if (!selected.length) return { ...base, profile: null, selected, used: [], warnings: [...warnings, 'No entities selected.'] };
  const chained = chainProfile(selected.map((i) => edges[i]));
  warnings.push(...chained.warnings);
  const used = chained.edgeIds.map((j) => selected[j]);
  // automatic: report the pick as the selection, so the picker shows what is actually cut
  return { ...base, profile: chained.profile, selected: selection ? selected : used, used, warnings };
}
