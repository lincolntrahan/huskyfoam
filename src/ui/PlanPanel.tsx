import type { CutResult } from '../core/cut/pipeline';
import { addSegment, bridgeGap, moveStep, removeStep, reverseStep, setSpeed } from '../core/plan/edit';
import { segSplits, type CutPlan, type PlanPoint, type PlanStep, type Topo } from '../core/plan/model';
import type { SegmentOverride } from '../core/types';

interface Props {
  plan: CutPlan;
  result: CutResult;
  onChange: (p: CutPlan) => void;
  onLoop: (reversed: boolean) => void;
  onLeTe: () => void;
  selected: number | null;
  onSelect: (i: number | null) => void;
  overrides: Record<number, SegmentOverride>;
  onOverride: (seg: number, o: SegmentOverride) => void;
  units: string;
}

/** Optional number: blank means "use the job default". */
function OptNum(props: { value: number | undefined; placeholder: string; label: string; onChange: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      step="any"
      min={0}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={props.value ?? ''}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        props.onChange(Number.isFinite(v) ? v : undefined);
      }}
    />
  );
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

function describe(step: PlanStep, plan: CutPlan, t: Topo): string {
  if (step.kind === 'segment') {
    const e = segSplits(t, step.seg);
    const a = e.start + 1;
    const b = e.end + 1;
    return step.reversed ? `Segment ${step.seg + 1}  (split ${b} → ${a})` : `Segment ${step.seg + 1}  (split ${a} → ${b})`;
  }
  return `${describePoint(step.from, plan)} → ${describePoint(step.to, plan)}`;
}

function GapRow(props: { before: number; plan: CutPlan; n: Topo; onChange: (p: CutPlan) => void }) {
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

export function PlanPanel({ plan, result, onChange, onLoop, onLeTe, selected, onSelect, overrides, onOverride, units }: Props) {
  const n = result.stats.segments;
  const topo = result.topology ?? n;
  const gapsBefore = new Set(result.gaps.map((g) => g.before));
  const stepWarn = new Set(result.warnings.flatMap((w) => (w.step === undefined ? [] : [w.step])));
  const uncut = result.path.length ? Array.from({ length: n }, (_, k) => k).filter((k) => !plan.steps.some((s) => s.kind === 'segment' && s.seg === k)) : [];
  const insertAt = selected === null ? plan.steps.length : selected + 1;

  return (
    <section>
      <h2>Cut plan</h2>
      <div className="row-buttons">
        <button className={plan.template === 'loop' ? 'active' : ''} onClick={() => onLoop(false)} title="Around the whole profile from the start point">
          Loop
        </button>
        <button className={plan.template === 'loop-reverse' ? 'active' : ''} onClick={() => onLoop(true)} title="Around the whole profile the other way">
          Loop (reverse)
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
            {gapsBefore.has(i) && <GapRow before={i} plan={plan} n={topo} onChange={onChange} />}
            <div
              className={`step ${s.kind === 'line' ? s.speed : 'segment'} ${selected === i ? 'selected' : ''} ${stepWarn.has(i) ? 'warned' : ''}`}
              onClick={() => onSelect(selected === i ? null : i)}
            >
              <span className="step-num">{i + 1}</span>
              <span className="step-desc">
                {describe(s, plan, topo)}
                {s.kind === 'segment' && overrides[s.seg] && (
                  <span className="badge" title="This segment has its own kerf/speed">
                    {overrides[s.seg].kerf !== undefined ? `k ${overrides[s.seg].kerf}` : ''}
                    {overrides[s.seg].kerf !== undefined && overrides[s.seg].speed !== undefined ? ' · ' : ''}
                    {overrides[s.seg].speed !== undefined ? `v ${overrides[s.seg].speed}` : ''}
                  </span>
                )}
              </span>
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
            {selected === i && s.kind === 'segment' && (
              <div className="step-override">
                <span>Segment {s.seg + 1}:</span>
                <label>
                  kerf
                  <OptNum
                    label={`segment ${s.seg + 1} kerf`}
                    placeholder="job"
                    value={overrides[s.seg]?.kerf}
                    onChange={(v) => onOverride(s.seg, { ...overrides[s.seg], kerf: v })}
                  />
                </label>
                <label>
                  speed
                  <OptNum
                    label={`segment ${s.seg + 1} speed`}
                    placeholder="job"
                    value={overrides[s.seg]?.speed}
                    onChange={(v) => onOverride(s.seg, { ...overrides[s.seg], speed: v })}
                  />
                </label>
                <small className="hint" style={{ margin: 0 }}>
                  {units}, {units}/min · blank = job value
                </small>
              </div>
            )}
          </li>
        ))}
        {gapsBefore.has(plan.steps.length) && (
          <li>
            <GapRow before={plan.steps.length} plan={plan} n={topo} onChange={onChange} />
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
