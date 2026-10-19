import type { KerfPoint } from '../types';

/**
 * Kerf at a given face speed, linearly interpolated from the material's table.
 * Speeds outside the table are clamped to the nearest end (`clamped` says so).
 */
export function kerfAt(table: KerfPoint[], speed: number): { kerf: number; clamped: boolean } {
  const t = table.filter((p) => Number.isFinite(p.speed) && Number.isFinite(p.kerf)).sort((a, b) => a.speed - b.speed);
  if (!t.length) return { kerf: 0, clamped: true };
  if (speed <= t[0].speed) return { kerf: t[0].kerf, clamped: speed < t[0].speed };
  const last = t[t.length - 1];
  if (speed >= last.speed) return { kerf: last.kerf, clamped: speed > last.speed };
  let i = 1;
  while (t[i].speed < speed) i++;
  const a = t[i - 1];
  const b = t[i];
  const u = b.speed === a.speed ? 0 : (speed - a.speed) / (b.speed - a.speed);
  return { kerf: a.kerf + (b.kerf - a.kerf) * u, clamped: false };
}
