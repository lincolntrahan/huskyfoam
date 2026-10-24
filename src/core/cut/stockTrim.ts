import type { Vec2 } from '../geom/vec';
import { writeGcode, type Move } from '../gcode/writer';
import type { MachinePreset } from '../types';

/**
 * Trimming raw stock to length: the board lies turned 90° from its cutting position, so what
 * will be its left and right faces are its front and back here. A straight wire cuts both.
 * All X positions are along the machine's X (front to back), Y up from the floor (Y = 0).
 */
export interface StockTrimSpec {
  /** Finished length, kept face to kept face (the eventual left/right size). */
  length: number;
  /** Board thickness (its height on the table). */
  thickness: number;
  /** X = 0 to the raw board's front face. */
  setback: number;
  /** Waste cut off the front. */
  trimFront: number;
  /** How far behind the back cut the wire steps before cutting back up, so the kept face is cut once. */
  backOffset: number;
  /** Full kerf width; each cut runs half of it into the waste. */
  kerf: number;
  /** How far above the board the wire travels between cuts. */
  clearance: number;
  /** Wire speed for the cuts, units/min. */
  speed: number;
}

export const defaultStockTrim = (units: 'in' | 'mm') =>
  units === 'in' ? { setback: 1, trimFront: 0.5, backOffset: 0.25 } : { setback: 25, trimFront: 12, backOffset: 6 };

export interface StockTrimResult {
  /** Wire positions in order, from home back to home. */
  path: { p: Vec2; kind: 'cut' | 'jog' }[];
  /** Wire centre on the front and back cuts, and where it cuts back up. */
  front: number;
  back: number;
  up: number;
  safe: number;
  errors: string[];
  gcode: string;
}

/**
 * Jog from home up and over to the front cut, cut down through the board, pull out to the
 * front along the floor and up, jog over the board to the back cut, cut down, step back
 * `backOffset` and cut up through the waste, then jog home over the board.
 */
export function stockTrim(spec: StockTrimSpec, machine: MachinePreset, wireWatts?: number | null): StockTrimResult {
  const k2 = spec.kerf / 2;
  const front = spec.setback + spec.trimFront - k2;
  const back = spec.setback + spec.trimFront + spec.length + k2;
  const up = back + spec.backOffset;
  const safe = spec.thickness + spec.clearance;
  const floor = Math.max(0, machine.travel.y[0]);
  const x0 = machine.travel.x[0];
  // out in front of the board along the floor, then up clear of it
  const out = Math.max(x0, spec.setback - spec.clearance);
  const home = machine.home;

  const errors: string[] = [];
  const pos = (v: number, what: string) => !(v > 0) && errors.push(`${what} must be more than 0.`);
  pos(spec.length, 'Finished length');
  pos(spec.thickness, 'Board thickness');
  pos(spec.speed, 'Cut speed');
  if (!(spec.setback >= 0)) errors.push('Distance to the board must be 0 or more.');
  if (!(spec.trimFront >= 0)) errors.push('Front trim must be 0 or more.');
  if (!(spec.kerf >= 0)) errors.push('Kerf must be 0 or more.');
  if (!(spec.clearance >= 0)) errors.push('Clearance must be 0 or more.');
  if (!(spec.backOffset > spec.kerf)) errors.push('Back step must be more than one kerf, or the cut back up runs into the kept face.');
  if (front < x0) errors.push(`The front cut (wire at X = ${front.toFixed(3)}) is in front of X = ${x0}: put the board further back or trim more off the front.`);
  if (up > machine.travel.x[1]) errors.push(`The back cut needs X = ${up.toFixed(3)}, past the machine's X travel (${machine.travel.x[1]}). Move the board forward or shorten it.`);
  if (safe > machine.travel.y[1]) errors.push(`Clearing the board needs Y = ${safe.toFixed(3)}, above the machine's Y travel (${machine.travel.y[1]}).`);

  const path: StockTrimResult['path'] = [{ p: home, kind: 'jog' }];
  const to = (x: number, y: number, kind: 'cut' | 'jog') => path.push({ p: { x, y }, kind });
  to(home.x, safe, 'jog');
  to(front, safe, 'jog');
  to(front, floor, 'cut');
  to(out, floor, 'cut');
  to(out, safe, out < spec.setback ? 'jog' : 'cut');
  to(back, safe, 'jog');
  to(back, floor, 'cut');
  to(up, floor, 'cut');
  to(up, safe, 'cut');
  to(home.x, safe, 'jog');
  to(home.x, home.y, 'jog');

  if (errors.length) return { path, front, back, up, safe, errors, gcode: '' };
  const moves: Move[] = [];
  for (let i = 1; i < path.length; i++) {
    const { p, kind } = path[i];
    const d = Math.hypot(p.x - path[i - 1].p.x, p.y - path[i - 1].p.y);
    if (d < 1e-12) continue;
    const v = Math.min(kind === 'cut' ? spec.speed : machine.jogSpeed, machine.maxSpeed);
    moves.push({ left: p, right: p, minutes: d / v, lead: kind === 'jog', speed: kind });
  }
  const gcode = writeGcode({ left: home, right: home }, moves, machine, spec.speed, { wireWatts });
  return { path, front, back, up, safe, errors, gcode };
}
