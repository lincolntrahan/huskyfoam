import { chainProfiles, isClosed, type Profile } from '../geom/profile';
import type { Vec2 } from '../geom/vec';
import type { Units } from '../types';
import { parseDxf, type DxfText, type Edge } from './dxf';

export interface LoadedProfile {
  /** The outer contour, in the target units (null if no contour could be built). */
  profile: Profile | null;
  /** Every contour to cut: the outer one first, then the others (holes, open cuts). */
  contours: Profile[];
  /** Entity indices making up each contour (same order as `contours`). */
  contourEdges: number[][];
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

/** Rotate a point CCW about the origin by `deg` (a multiple of 90, so it stays exact). */
export function rotate90(p: Vec2, deg: number): Vec2 {
  switch ((((Math.round(deg / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3) {
    case 1:
      return { x: -p.y, y: p.x };
    case 2:
      return { x: -p.x, y: -p.y };
    case 3:
      return { x: p.y, y: -p.x };
    default:
      return p;
  }
}

/**
 * Parse a DXF into its contours, converted to `target` units and rotated by `rotation` degrees
 * (multiples of 90, CCW) to match the cutter's axes. `selection` limits it to those entity
 * indices; null = automatic: the largest closed outline and every contour inside it.
 */
export function loadDxfProfile(text: string, target: Units, selection: number[] | null = null, rotation = 0): LoadedProfile {
  const dxf = parseDxf(text);
  const warnings = [...dxf.warnings];
  const k = dxf.units && dxf.units !== target ? toMm[dxf.units] / toMm[target] : 1;
  const sc = (p: Vec2) => rotate90(k === 1 ? p : { x: p.x * k, y: p.y * k }, rotation);
  const edges = dxf.edges.map((e) => ({ ...e, pts: e.pts.map(sc) }));
  const texts = dxf.texts.map((t) => ({ ...t, at: sc(t.at), height: t.height * k }));
  if (!dxf.units) warnings.push(`The DXF does not say what units it uses; assuming ${target}.`);
  const base = { fileUnits: dxf.units, edges, texts };
  const none = { profile: null, contours: [], contourEdges: [], used: [] };
  if (!edges.length) return { ...base, ...none, selected: [], warnings: [...warnings, 'No usable geometry in this DXF.'] };

  const selected = selection ? selection.filter((i) => i >= 0 && i < edges.length) : edges.map((_, i) => i);
  if (!selected.length) return { ...base, ...none, selected, warnings: [...warnings, 'No entities selected.'] };
  const chained = chainProfiles(selected.map((i) => edges[i]));
  let contours = chained.contours;
  let ids = chained.edgeIds.map((list) => list.map((j) => selected[j]));
  if (!selection) {
    // automatic: the largest closed outline plus whatever lies inside it (spar holes, slots)
    const outer = contours.findIndex(isClosed);
    if (outer < 0) {
      return { ...base, ...none, selected: [], warnings: [...warnings, `No closed outline found (${contours.length} open chain${contours.length === 1 ? '' : 's'}). Pick the entities to cut, or check for gaps between them.`] };
    }
    const box = bounds(contours[outer].pts);
    const keep = contours.map((c, i) => i === outer || (i !== outer && c.pts.every((p) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1)));
    const skipped = keep.filter((k) => !k).length;
    if (skipped) warnings.push(`Auto pick uses the largest closed outline and what lies inside it; ${skipped} other contour${skipped === 1 ? ' was' : 's were'} left out.`);
    contours = contours.filter((_, i) => keep[i]);
    ids = ids.filter((_, i) => keep[i]);
  }
  if (contours.length && !isClosed(contours[0])) warnings.push('The selection has no closed outline; the first open contour is treated as the outer one.');
  const used = ids.flat().sort((a, b) => a - b);
  // automatic: report the pick as the selection, so the picker shows what is actually cut
  return { ...base, profile: contours[0] ?? null, contours, contourEdges: ids, selected: selection ? selected : used, used, warnings };
}

function bounds(pts: Vec2[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
