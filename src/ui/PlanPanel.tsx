import type { CutResult } from '../core/cut/pipeline';
import { addSegment, bridgeGap, moveStep, removeStep, reverseStep, setSpeed } from '../core/plan/edit';
import type { CutPlan, PlanPoint, PlanStep } from '../core/plan/model';

interface Props {
  plan: CutPlan;
  result: CutResult;
  onChange: (p: CutPlan) => void;
  onLoop: () => void;
  onLeTe: () => void;
  selected: number | null;
  onSelect: (i: number | null) => void;
}

const fmt = (v: number) => v.toFixed(3);

function describePoint(id: string, plan: CutPlan): string {
  const p: PlanPoint | undefined = plan.points[id];
  if (!p) return '?';
  switch (p.kind) {
    case 'home':
      return 'home';
    case 'split':
      return `split ${p.split + 1}`;
    case 'free':
      return `(${fmt(p.p.x)}, ${fmt(p.p.y)})`;
    case 'freePair':
      return `root (${fmt(p.r.x)}, ${fmt(p.r.y)}) / tip (${fmt(p.t.x)}, ${fmt(p.t.y)})`;
  }
}

function describe(step: PlanStep, plan: CutPlan, n: number): string {
  if (step.kind === 'segment') {
    const a = step.seg + 1;
    const b = ((step.seg + 1) % n) + 1;
    return step.reversed ? `Segment ${a}  (split ${b} → ${a})` : `Segment ${a}  (split ${a} → ${b})`;
  }
  return `${describePoint(step.from, plan)} → ${describePoint(step.to, plan)}`;
}

function GapRow(props: { before: number; plan: CutPlan; n: number; onChange: (p: CutPlan) => void }) {
  return (
    <div className="step gap">
      <span>Gap: the path jumps here</span>
      <span className="step-actions">
        <button onClick={() => props.onChange(bridgeGap(props.plan, props.before, 'jog', props.n))}>Bridge with jog</button>
        <button onClick={() => props.onChange(bridgeGap(props.plan, props.before, 'cut', props.n))}>Bridge with cut</button>
      </span>
    </div>
  );
}

export function PlanPanel({ plan, result, onChange, onLoop, onLeTe, selected, onSelect }: Props) {
  const n = result.stats.segments;
  const gapsBefore = new Set(result.gaps.map((g) => g.before));
  const stepWarn = new Set(result.warnings.flatMap((w) => (w.step === undefined ? [] : [w.step])));
  const uncut = result.path.length ? Array.from({ length: n }, (_, k) => k).filter((k) => !plan.steps.some((s) => s.kind === 'segment' && s.seg === k)) : [];
  const insertAt = selected === null ? plan.steps.length : selected + 1;

  return (
    <section>
      <h2>Cut plan</h2>
      <div className="row-buttons">
        <button className={plan.template === 'loop' ? 'active' : ''} onClick={onLoop} title="Around the whole profile from the start point">
          Loop
        </button>
        <button className={plan.template === 'le-te' ? 'active' : ''} onClick={onLeTe} title="Upper surface LE→TE, jog back over the block, lower surface LE→TE">
          LE→TE top &amp; bottom
        </button>
      </div>
      <small className="hint">
        On the canvas: click a split marker to run out, out-and-back, or finish a run-in; click a line to switch cut/jog, add a point or delete it; drag
        points to move them (Shift-drag unlocks root/tip).
      </small>

      <ol className="steps">
        {plan.steps.map((s, i) => (
          <li key={s.id}>
            {gapsBefore.has(i) && <GapRow before={i} plan={plan} n={n} onChange={onChange} />}
            <div
              className={`step ${s.kind === 'line' ? s.speed : 'segment'} ${selected === i ? 'selected' : ''} ${stepWarn.has(i) ? 'warned' : ''}`}
              onClick={() => onSelect(selected === i ? null : i)}
            >
              <span className="step-num">{i + 1}</span>
              <span className="step-desc">{describe(s, plan, n)}</span>
              <span className="step-actions" onClick={(e) => e.stopPropagation()}>
                {s.kind === 'line' && (
                  <button className="speed" onClick={() => onChange(setSpeed(plan, i, s.speed === 'cut' ? 'jog' : 'cut'))} title="Switch between cut and jog speed">
                    {s.speed}
                  </button>
                )}
                <button onClick={() => onChange(reverseStep(plan, i))} title="Reverse direction">⇄</button>
                <button disabled={i === 0} onClick={() => onChange(moveStep(plan, i, -1))} title="Move up">↑</button>
                <button disabled={i === plan.steps.length - 1} onClick={() => onChange(moveStep(plan, i, 1))} title="Move down">↓</button>
                <button onClick={() => onChange(removeStep(plan, i))} title="Remove step">✕</button>
              </span>
            </div>
          </li>
        ))}
        {gapsBefore.has(plan.steps.length) && (
          <li>
            <GapRow before={plan.steps.length} plan={plan} n={n} onChange={onChange} />
          </li>
        )}
      </ol>

      {uncut.length > 0 && (
        <div className="row-buttons">
          <span className="hint">Add uncut segment {selected === null ? 'at end' : `after step ${selected + 1}`}:</span>
          {uncut.map((k) => (
            <button key={k} onClick={() => onChange(addSegment(plan, insertAt, k, false))} title={`Add segment ${k + 1} forward`}>
              {k + 1}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
