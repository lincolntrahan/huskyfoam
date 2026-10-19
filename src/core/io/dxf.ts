import { flattenNurbs } from '../geom/nurbs';
import type { Vec2 } from '../geom/vec';
import type { Units } from '../types';

/** One drawable piece of geometry, already flattened to a dense polyline. */
export interface Edge {
  pts: Vec2[];
  source: string; // entity type, for messages
}

export interface DxfResult {
  edges: Edge[];
  units: Units | null; // null when the file doesn't say
  warnings: string[];
}

interface Pair {
  code: number;
  value: string;
}

function readPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1].trim() });
  }
  return pairs;
}

const ARC_STEP_RAD = (2 * Math.PI) / 180; // 2 degrees

function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): Vec2[] {
  // CCW from a0 to a1 (radians)
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 2 * Math.PI;
  const n = Math.max(2, Math.ceil(sweep / ARC_STEP_RAD));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Points along a polyline segment from p to q with DXF bulge (tan(sweep/4), + = CCW). */
function bulgePoints(p: Vec2, q: Vec2, bulge: number): Vec2[] {
  if (Math.abs(bulge) < 1e-12) return [p, q];
  const sweep = 4 * Math.atan(bulge);
  const chord = Math.hypot(q.x - p.x, q.y - p.y);
  const r = Math.abs(chord / (2 * Math.sin(sweep / 2)));
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  // signed distance from chord midpoint to center, along the left normal of p->q
  const h = chord / 2 / Math.tan(sweep / 2);
  const ux = (q.x - p.x) / chord;
  const uy = (q.y - p.y) / chord;
  const cx = mx - uy * h;
  const cy = my + ux * h;
  const a0 = Math.atan2(p.y - cy, p.x - cx);
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP_RAD));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  pts[0] = p;
  pts[n] = q;
  return pts;
}

function polylineEdges(verts: Vec2[], bulges: number[], closed: boolean, source: string): Edge[] {
  const edges: Edge[] = [];
  const count = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < count; i++) {
    const p = verts[i];
    const q = verts[(i + 1) % verts.length];
    if (p.x === q.x && p.y === q.y) continue;
    edges.push({ pts: bulgePoints(p, q, bulges[i] ?? 0), source });
  }
  return edges;
}

type Group = Pair[];

/** Split the ENTITIES section into one group of pairs per entity (code 0 starts a new one). */
function entityGroups(pairs: Pair[]): Group[] {
  const groups: Group[] = [];
  let inEntities = false;
  let current: Group | null = null;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.code === 2 && p.value === 'ENTITIES' && pairs[i - 1]?.value === 'SECTION') {
      inEntities = true;
      continue;
    }
    if (!inEntities) continue;
    if (p.code === 0) {
      if (p.value === 'ENDSEC') break;
      current = [p];
      groups.push(current);
    } else current?.push(p);
  }
  return groups;
}

const nums = (g: Group, code: number) => g.filter((p) => p.code === code).map((p) => parseFloat(p.value));
const num = (g: Group, code: number, dflt = 0) => {
  const f = g.find((p) => p.code === code);
  return f ? parseFloat(f.value) : dflt;
};

function headerUnits(pairs: Pair[]): Units | null {
  const i = pairs.findIndex((p) => p.code === 9 && p.value === '$INSUNITS');
  if (i < 0) return null;
  const v = parseInt(pairs[i + 1]?.value ?? '', 10);
  if (v === 1) return 'in';
  if (v === 4) return 'mm';
  return null;
}

export function parseDxf(text: string): DxfResult {
  const pairs = readPairs(text);
  const groups = entityGroups(pairs);
  const edges: Edge[] = [];
  const ignored = new Map<string, number>();
  const warnings: string[] = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const type = g[0].value;
    switch (type) {
      case 'LINE': {
        edges.push({
          pts: [
            { x: num(g, 10), y: num(g, 20) },
            { x: num(g, 11), y: num(g, 21) },
          ],
          source: type,
        });
        break;
      }
      case 'ARC': {
        const d2r = Math.PI / 180;
        edges.push({ pts: arcPoints(num(g, 10), num(g, 20), num(g, 40), num(g, 50) * d2r, num(g, 51) * d2r), source: type });
        break;
      }
      case 'CIRCLE': {
        const pts = arcPoints(num(g, 10), num(g, 20), num(g, 40), 0, 2 * Math.PI);
        edges.push({ pts, source: type });
        break;
      }
      case 'LWPOLYLINE': {
        const closed = (num(g, 70) & 1) === 1;
        const verts: Vec2[] = [];
        const bulges: number[] = [];
        for (const p of g) {
          if (p.code === 10) {
            verts.push({ x: parseFloat(p.value), y: 0 });
            bulges.push(0);
          } else if (p.code === 20 && verts.length) verts[verts.length - 1].y = parseFloat(p.value);
          else if (p.code === 42 && verts.length) bulges[verts.length - 1] = parseFloat(p.value);
        }
        edges.push(...polylineEdges(verts, bulges, closed, type));
        break;
      }
      case 'POLYLINE': {
        const closed = (num(g, 70) & 1) === 1;
        const verts: Vec2[] = [];
        const bulges: number[] = [];
        while (groups[gi + 1] && groups[gi + 1][0].value === 'VERTEX') {
          gi++;
          const vg = groups[gi];
          verts.push({ x: num(vg, 10), y: num(vg, 20) });
          bulges.push(num(vg, 42));
        }
        if (groups[gi + 1]?.[0].value === 'SEQEND') gi++;
        edges.push(...polylineEdges(verts, bulges, closed, type));
        break;
      }
      case 'SPLINE': {
        const degree = num(g, 71, 3);
        const knots = nums(g, 40);
        const weights = nums(g, 41);
        const cx = nums(g, 10);
        const cy = nums(g, 20);
        const ctrl = cx.map((x, i) => ({ x, y: cy[i] }));
        if (ctrl.length > degree && knots.length === ctrl.length + degree + 1) {
          edges.push({
            pts: flattenNurbs({ degree, knots, ctrl, weights: weights.length === ctrl.length ? weights : undefined }),
            source: type,
          });
        } else {
          // Fit-point-only spline: fall back to a polyline through the fit points.
          const fx = nums(g, 11);
          const fy = nums(g, 21);
          if (fx.length >= 2) {
            edges.push({ pts: fx.map((x, i) => ({ x, y: fy[i] })), source: type });
            warnings.push('A SPLINE had only fit points; it was imported as straight segments between them.');
          } else warnings.push('Skipped a SPLINE with invalid control data.');
        }
        break;
      }
      default:
        ignored.set(type, (ignored.get(type) ?? 0) + 1);
    }
  }

  const ignorable = new Set(['TEXT', 'MTEXT', 'DIMENSION', 'INSERT', 'POINT', 'HATCH', 'ATTDEF', 'VIEWPORT']);
  for (const [type, count] of ignored) {
    if (!ignorable.has(type)) warnings.push(`Ignored ${count} unsupported ${type} entit${count === 1 ? 'y' : 'ies'}.`);
  }
  return { edges, units: headerUnits(pairs), warnings };
}
