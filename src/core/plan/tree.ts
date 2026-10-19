import {
  asTopology,
  clonePlan,
  emptyPlan,
  HOME,
  newId,
  prunePoints,
  splitId,
  type CutPlan,
  type PlanGroup,
  type PlanPoint,
  type PlanStep,
  type Topo,
  type Topology,
} from './model';
import { leTePlan, type LeTeInput } from './templates';

/**
 * The sequence as a feature tree (SPEC M2f): folders of steps, templates applied one contour
 * pair at a time, jogs that start wherever the wire is, and edits that insert at a position
 * (the rollback bar). Folders are one level deep: a folder is the run of steps carrying its id.
 */

export type PairTemplate = 'loop' | 'loop-reverse' | 'le-te';

export const TEMPLATE_LABEL: Record<PairTemplate, string> = { loop: 'Loop', 'loop-reverse': 'Loop (reverse)', 'le-te': 'LE→TE top & bottom' };

const custom = (p: CutPlan): CutPlan => prunePoints({ ...p, template: 'custom', groups: p.groups ?? [] });

/** Index of the jog home at the end of the plan, or -1. */
const homeJogAt = (plan: CutPlan) => {
  const last = plan.steps[plan.steps.length - 1];
  return last?.kind === 'jog' && last.to === HOME && !last.group ? plan.steps.length - 1 : -1;
};

/** Make sure the plan ends with a jog home over the block. */
function ensureHomeJog(p: CutPlan) {
  if (homeJogAt(p) >= 0) return;
  p.steps.push({ id: newId(p, 'j'), kind: 'jog', to: HOME, route: 'over' });
}

/**
 * The steps that cut pair `pair` with a template, added to `p` (points and ids are created in
 * it). They start with a jog over the block to where the cut begins, so they connect to
 * whatever comes before.
 */
function pairSteps(p: CutPlan, t: Topology, pair: number, tpl: PairTemplate, leTe?: LeTeInput): PlanStep[] {
  const c = t.contours[pair];
  if (!c) return [];
  const steps: PlanStep[] = [];
  const point = (prefix: string, pt: PlanPoint) => {
    const id = newId(p, prefix);
    p.points[id] = pt;
    return id;
  };
  const split = (k: number) => {
    p.points[splitId(k)] = { kind: 'split', split: k };
    return splitId(k);
  };
  // ids are taken as steps are created, so they never clash
  const stepId = (prefix: string) => {
    const id = newId({ ...p, steps: [...p.steps, ...steps] }, prefix);
    return id;
  };
  const jog = (to: string) => steps.push({ id: stepId('j'), kind: 'jog', to, route: 'over' });
  const line = (from: string, to: string) => steps.push({ id: stepId('l'), kind: 'line', from, to, speed: 'cut' });
  const seg = (g: number, reversed: boolean) => steps.push({ id: stepId('g'), kind: 'segment', seg: g, reversed });
  const segs = Array.from({ length: c.segs }, (_, j) => c.seg0 + j);
  const reversed = tpl === 'loop-reverse';

  if (pair === 0 && tpl === 'le-te' && leTe) {
    // the LE→TE plan from the template, with fresh ids, minus its trips to and from home
    const src = leTePlan(leTe);
    const ids = new Map<string, string>([[HOME, HOME]]);
    for (const [id, pt] of Object.entries(src.points)) {
      if (id === HOME) continue;
      if (pt.kind === 'split') ids.set(id, split(pt.split));
      else ids.set(id, point('p', pt));
    }
    const body = src.steps.slice(1, -1);
    const first = body[0];
    if (first?.kind === 'line') jog(ids.get(first.from)!);
    for (const s of body) {
      if (s.kind === 'segment') seg(s.seg, s.reversed);
      else if (s.kind === 'line') steps.push({ id: stepId('l'), kind: 'line', from: ids.get(s.from)!, to: ids.get(s.to)!, speed: s.speed });
    }
    return steps;
  }

  if (pair === 0) {
    // the outline: straight up from home to the start's height and across, the reverse on the way out
    const first = !c.closed && reversed ? c.split0 + c.splits - 1 : c.split0;
    const last = c.closed ? c.split0 : reversed ? c.split0 : c.split0 + c.splits - 1;
    const corner = reversed ? { corner: 'last' as const } : {};
    const lin = point('v', { kind: 'level', split: first, ...corner });
    const lout = point('v', { kind: 'level', split: last, ...corner });
    jog(lin);
    line(lin, split(first));
    for (const g of reversed ? segs.slice().reverse() : segs) seg(g, reversed);
    line(split(last), lout);
    return steps;
  }

  // an inner contour: plunge straight down from above its start, cut round (or along and back), and back up
  const start = c.split0;
  const above = point('a', { kind: 'above', split: start, ...(reversed && c.closed ? { corner: 'last' as const } : {}) });
  jog(above);
  line(above, split(start));
  if (c.closed) for (const g of reversed ? segs.slice().reverse() : segs) seg(g, reversed);
  else {
    for (const g of segs) seg(g, false);
    for (const g of segs.slice().reverse()) seg(g, true);
  }
  line(split(start), above);
  return steps;
}

/**
 * Cut pair `pair` with a template, in a folder named for it. A folder that already cuts the
 * pair is replaced where it is; otherwise the folder goes at `at` (before the final jog home
 * when that is where `at` points). A plan without folders (from before them) starts over.
 */
export function applyPairTemplate(plan: CutPlan | null, t: Topo, pair: number, tpl: PairTemplate, at: number, leTe?: LeTeInput): CutPlan {
  const topo = asTopology(t);
  const p = plan?.groups ? clonePlan(plan) : emptyPlan();
  p.groups ??= [];
  const old = p.groups.find((g) => g.pair === pair);
  let index = Math.min(at, p.steps.length);
  if (old) {
    const first = p.steps.findIndex((s) => s.group === old.id);
    p.steps = p.steps.filter((s) => s.group !== old.id);
    if (first >= 0) index = first;
    else index = Math.min(index, p.steps.length);
    p.groups = p.groups.filter((g) => g.id !== old.id);
  }
  const home = homeJogAt(p);
  if (home >= 0 && index > home) index = home;
  const group: PlanGroup = { id: newId(p, 'f'), name: `Pair ${pair + 1} · ${TEMPLATE_LABEL[tpl]}`, pair, template: tpl };
  p.groups.push(group);
  const steps = pairSteps(p, topo, pair, tpl, leTe).map((s) => ({ ...s, group: group.id }));
  p.steps.splice(index, 0, ...steps);
  ensureHomeJog(p);
  return custom(p);
}

/**
 * The default sequence: every inner pair first (in the order given, e.g. along the chord), each
 * plunged in from above with a Loop, then the outline as a Loop, then home.
 */
export function sequenceAll(t: Topo, innerOrder: number[]): CutPlan {
  const topo = asTopology(t);
  let p = emptyPlan();
  const inner = innerOrder.filter((k) => k > 0 && k < topo.contours.length);
  for (const k of inner) p = applyPairTemplate(p, topo, k, 'loop', p.steps.length);
  return applyPairTemplate(p, topo, 0, 'loop', p.steps.length);
}

// ---------------------------------------------------------------- tree edits

/** Folder a step index is in (or undefined). */
export const groupAt = (plan: CutPlan, i: number) => plan.steps[i]?.group;

/**
 * Move step `from` so it ends up before what is now step `to` (to = steps.length: the end),
 * into folder `group` (undefined = top level).
 */
export function moveStepTo(plan: CutPlan, from: number, to: number, group: string | undefined): CutPlan {
  const p = clonePlan(plan);
  const [s] = p.steps.splice(from, 1);
  if (!s) return plan;
  const index = to > from ? to - 1 : to;
  p.steps.splice(index, 0, group ? { ...s, group } : { ...s, group: undefined });
  return custom(p);
}

/** Move a whole folder so it starts before what is now step `to`. */
export function moveGroupTo(plan: CutPlan, id: string, to: number): CutPlan {
  const p = clonePlan(plan);
  const inside = p.steps.filter((s) => s.group === id);
  if (!inside.length) return plan;
  const before = p.steps.slice(0, to).filter((s) => s.group !== id).length;
  const rest = p.steps.filter((s) => s.group !== id);
  rest.splice(before, 0, ...inside);
  p.steps = rest;
  return custom(p);
}

export function addGroup(plan: CutPlan, name: string): { plan: CutPlan; id: string } {
  const p = clonePlan(plan);
  p.groups ??= [];
  const id = newId(p, 'f');
  p.groups.push({ id, name });
  return { plan: custom(p), id };
}

export function renameGroup(plan: CutPlan, id: string, name: string): CutPlan {
  const p = clonePlan(plan);
  p.groups = (p.groups ?? []).map((g) => (g.id === id ? { ...g, name } : g));
  return custom(p);
}

/** Delete a folder; `withSteps` also deletes what is in it (else its steps move to the top level). */
export function removeGroup(plan: CutPlan, id: string, withSteps: boolean): CutPlan {
  const p = clonePlan(plan);
  p.groups = (p.groups ?? []).filter((g) => g.id !== id);
  p.steps = withSteps ? p.steps.filter((s) => s.group !== id) : p.steps.map((s) => (s.group === id ? { ...s, group: undefined } : s));
  return custom(p);
}

/** Insert steps at `at`, in the folder of the step they land next to (the one above). */
function insertAt(p: CutPlan, at: number, steps: PlanStep[]): CutPlan {
  const group = at > 0 ? p.steps[at - 1]?.group : undefined;
  p.steps.splice(at, 0, ...steps.map((s) => (group ? { ...s, group } : s)));
  p.groups ??= [];
  return custom(p);
}

/** Insert a jog (over the block by default) from wherever the wire is to a split or home. */
export function insertJog(plan: CutPlan, at: number, to: { split: number } | 'home', route: 'over' | 'straight' = 'over'): CutPlan {
  const p = clonePlan(plan);
  let id: string = HOME;
  if (to !== 'home') {
    id = splitId(to.split);
    p.points[id] = { kind: 'split', split: to.split };
  }
  return insertAt(p, at, [{ id: newId(p, 'j'), kind: 'jog', to: id, route }]);
}

/** Insert a segment step. */
export function insertSegment(plan: CutPlan, at: number, seg: number, reversed: boolean): CutPlan {
  const p = clonePlan(plan);
  return insertAt(p, at, [{ id: newId(p, 'g'), kind: 'segment', seg, reversed }]);
}

/**
 * Insert a chain of cut lines from where the wire is at `at` (the end of the step above, or
 * home) through free points, ending at a split or at the last point.
 */
export function insertCutPath(plan: CutPlan, at: number, fromRef: string, through: PlanPoint[], endSplit: number | null): CutPlan {
  const p = clonePlan(plan);
  const ids = [fromRef];
  for (const pt of through) {
    const id = newId(p, 'p');
    p.points[id] = pt;
    ids.push(id);
  }
  if (endSplit !== null) {
    p.points[splitId(endSplit)] = { kind: 'split', split: endSplit };
    ids.push(splitId(endSplit));
  }
  const lines: PlanStep[] = [];
  for (let j = 1; j < ids.length; j++) {
    lines.push({ id: newId({ ...p, steps: [...p.steps, ...lines] }, 'l'), kind: 'line', from: ids[j - 1], to: ids[j], speed: 'cut' });
  }
  return insertAt(p, at, lines);
}
