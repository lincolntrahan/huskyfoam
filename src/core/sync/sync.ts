import { arcLoop, sAtIndex, sliceS, spanS, withinS, wrapS, type ArcLoop } from '../geom/arc';
import type { Profile } from '../geom/profile';
import type { Vec2 } from '../geom/vec';
import type { SamplingSettings } from '../types';
import { resamplePair } from './resample';
import { autoSplits, defaultStart } from './segments';

/** A sync pair inside a segment: arc positions on the root and tip loops. */
export interface Pin {
  root: number;
  tip: number;
}

/**
 * Where root and tip are matched. Split positions are arc lengths along each profile, listed
 * in loop order starting at the loop start (index 0). Both lists always have the same length.
 */
export interface SyncSettings {
  root: number[];
  tip: number[];
  pins: Pin[];
}

/** Default sync: entity boundaries + sharp corners, loop starting at the -X-most split. */
export function autoSync(root: Profile, tip: Profile, cornerDeg: number): SyncSettings {
  const side = (p: Profile) => {
    const a = arcLoop(p);
    const splits = autoSplits(p, cornerDeg);
    const k = splits.indexOf(defaultStart(p, splits));
    return [...splits.slice(k), ...splits.slice(0, k)].map((i) => sAtIndex(a, i));
  };
  return { root: side(root), tip: side(tip), pins: [] };
}

export interface SyncedStation {
  r: Vec2;
  t: Vec2;
  seg: number;
  boundary: boolean;
}

/**
 * Resample every matched segment pair to equal point counts. Pins inside a segment split the
 * resampling (so the pin points line up) without starting a new segment.
 * Returns stations for the closed loop (no repeated closing station).
 */
export function syncStations(
  rootArc: ArcLoop,
  tipArc: ArcLoop,
  sync: SyncSettings,
  sampling: SamplingSettings,
): { stations: SyncedStation[]; warnings: string[] } {
  const n = sync.root.length;
  const stations: SyncedStation[] = [];
  const warnings: string[] = [];
  const usedPins = new Set<number>();

  for (let k = 0; k < n; k++) {
    const r0 = sync.root[k];
    const r1 = sync.root[(k + 1) % n];
    const t0 = sync.tip[k];
    const t1 = sync.tip[(k + 1) % n];
    // pins whose root AND tip both lie inside this segment, ordered along the root
    const inside = sync.pins
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => withinS(rootArc, r0, r1, p.root) && withinS(tipArc, t0, t1, p.tip))
      .sort((a, b) => wrapS(rootArc, a.p.root - r0) - wrapS(rootArc, b.p.root - r0));
    // tip order must match root order; drop pins that would cross
    const ordered: typeof inside = [];
    for (const pin of inside) {
      const last = ordered[ordered.length - 1];
      if (last && wrapS(tipArc, pin.p.tip - t0) <= wrapS(tipArc, last.p.tip - t0)) {
        warnings.push(`Pin ${pin.i + 1} crosses pin ${last.i + 1} (their root and tip order differ) and is ignored.`);
        continue;
      }
      ordered.push(pin);
    }
    ordered.forEach(({ i }) => usedPins.add(i));

    const rb = [r0, ...ordered.map((o) => o.p.root), r1];
    const tb = [t0, ...ordered.map((o) => o.p.tip), t1];
    for (let j = 0; j < rb.length - 1; j++) {
      const ra = sliceS(rootArc, rb[j], rb[j + 1]);
      const ta = sliceS(tipArc, tb[j], tb[j + 1]);
      const { a, b } = resamplePair(ra, ta, sampling);
      for (let i = 0; i < a.length - 1; i++) stations.push({ r: a[i], t: b[i], seg: k, boundary: j === 0 && i === 0 });
    }
  }
  sync.pins.forEach((_, i) => {
    if (!usedPins.has(i) && !warnings.some((w) => w.startsWith(`Pin ${i + 1} `))) {
      warnings.push(`Pin ${i + 1} is ignored: its root and tip points are in different segments.`);
    }
  });
  return { stations, warnings };
}

/** Segment k containing arc position s on the given side, and the fraction along it. */
export function locate(arc: ArcLoop, splits: number[], s: number): { k: number; f: number } | null {
  const n = splits.length;
  for (let k = 0; k < n; k++) {
    const a = splits[k];
    const b = splits[(k + 1) % n];
    if (withinS(arc, a, b, s)) return { k, f: wrapS(arc, s - a) / spanS(arc, a, b) };
  }
  return null;
}

/** Arc position at fraction f along segment k. */
export function atFraction(arc: ArcLoop, splits: number[], k: number, f: number): number {
  const a = splits[k];
  const b = splits[(k + 1) % splits.length];
  return wrapS(arc, a + f * spanS(arc, a, b));
}
