import type { CutResult, Stage } from '../core/cut/pipeline';
import type { Layers } from './Preview2D';

export type StepId = 'import' | 'setup' | 'transform' | 'segment' | 'sequence' | 'preview' | 'export';

export interface StepDef {
  id: StepId;
  label: string;
  /** Problem stages this page owns. */
  stage: Stage | null;
  /** Canvas layers switched on when you arrive at the page (you can still toggle them). */
  layers: Layers;
}

const L = (profiles: boolean, kerf: boolean, plan: boolean, carriages: boolean): Layers => ({ profiles, kerf, plan, carriages });

export const STEPS: StepDef[] = [
  { id: 'import', label: 'Import Geometry', stage: 'import', layers: L(true, false, false, false) },
  { id: 'transform', label: 'Arrange Profiles', stage: 'transform', layers: L(true, false, false, false) },
  { id: 'setup', label: 'Place in Machine', stage: 'setup', layers: L(true, true, false, true) },
  { id: 'segment', label: 'Segment Profiles', stage: 'segment', layers: L(true, false, false, false) },
  { id: 'sequence', label: 'Sequence Cuts', stage: 'sequence', layers: L(true, true, true, false) },
  { id: 'preview', label: 'Preview Cut Path', stage: 'path', layers: L(true, true, true, true) },
  { id: 'export', label: 'Export G-Code', stage: null, layers: L(true, false, true, true) },
];

const STAGE_ORDER: Stage[] = ['import', 'transform', 'setup', 'segment', 'sequence', 'path'];

/** Problem stages to show on a page: its own and every earlier one (Export shows everything). */
export function stagesUpTo(step: StepId): Set<Stage> {
  const def = STEPS.find((s) => s.id === step)!;
  const last = def.stage ? STAGE_ORDER.indexOf(def.stage) : STAGE_ORDER.length - 1;
  return new Set(STAGE_ORDER.slice(0, last + 1));
}

export type StepStatus = 'ok' | 'warn' | 'error' | 'locked';

export interface StepState {
  status: StepStatus;
  /** Why it's locked (the first earlier step that isn't done). */
  reason?: string;
}

/**
 * Each page's status, and which pages are unlocked: a page opens once every page before it
 * has no errors (import needs both profiles loaded as closed outlines).
 */
export function stepStates(opts: { haveProfiles: boolean; importWarnings: number; result: CutResult | null }): Record<StepId, StepState> {
  const { result } = opts;
  const errs = (stage: Stage) => (result ? result.errorStages.filter((s) => s === stage).length : 0);
  const warns = (stage: Stage) => (result ? result.warnings.filter((w) => w.stage === stage).length : 0);
  const out = {} as Record<StepId, StepState>;
  let blocker: string | null = null;
  for (const step of STEPS) {
    if (blocker) {
      out[step.id] = { status: 'locked', reason: blocker };
      continue;
    }
    let bad: boolean;
    let warn: boolean;
    if (step.id === 'import') {
      bad = !opts.haveProfiles;
      warn = opts.importWarnings > 0;
    } else if (step.id === 'export') {
      bad = !result?.ok;
      warn = (result?.warnings.length ?? 0) > 0;
    } else {
      bad = errs(step.stage!) > 0 || !result;
      warn = warns(step.stage!) > 0;
    }
    out[step.id] = { status: bad ? 'error' : warn ? 'warn' : 'ok' };
    if (bad) blocker = step.id === 'import' ? 'Load a root and a tip profile first.' : `Fix the problems in “${step.label}” first.`;
  }
  return out;
}
