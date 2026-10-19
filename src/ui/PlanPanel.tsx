import { useState } from 'react';
import type { CutResult } from '../core/cut/pipeline';
import { bridgeGap, removeStep, reverseStep, setSpeed } from '../core/plan/edit';
import { clonePlan, segSplits, type CutPlan, type PlanPoint, type PlanStep, type Topo } from '../core/plan/model';
import { addGroup, moveGroupTo, moveStepTo, removeGroup, renameGroup, TEMPLATE_LABEL, type PairTemplate } from '../core/plan/tree';
import type { SegmentOverride } from '../core/types';
import { pairColor } from './DxfPicker';

/** What the canvas is waiting for after an insert button: a split to jog to, a segment, or a cut path. */
export type Pick = 'jog' | 'segment' | 'line' | null;

interface Props {
  plan: CutPlan;
  result: CutResult;
  onChange: (p: CutPlan) => void;
  selected: number | null;
  onSelect: (i: number | null) => void;
  overrides: Record<number, SegmentOverride>;
  onOverride: (seg: number, o: SegmentOverride) => void;
  units: string;
  /** Pair the template buttons apply to. */
  pair: number | null;
  onPair: (p: number | null) => void;
  onTemplate: (t: PairTemplate) => void;
  onSequenceAll: () => void;
  onClear: () => void;
  /** Steps from this index on are rolled back (hidden); steps.length = the bar is at the bottom. */
  bar: number;
  onBar: (index: number) => void;
  pick: Pick;
  onPick: (p: Pick) => void;
  onJogHome: () => void;
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
    case 'level':
      return `home X at split ${p.split + 1} height`;
    case 'above':
      return `above split ${p.split + 1}`;
  }
}

function describe(step: PlanStep, plan: CutPlan, t: Topo): string {
  if (step.kind === 'segment') {
    const e = segSplits(t, step.seg);
    const a = e.start + 1;
    const b = e.end + 1;
    return step.reversed ? `Segment ${step.seg + 1}  (split ${b} → ${a})` : `Segment ${step.seg + 1}  (split ${a} → ${b})`;
  }
  if (step.kind === 'jog') return `Jog ${step.route === 'over' ? 'over the block ' : ''}to ${describePoint(step.to, plan)}`;
  const [a, b] = [plan.points[step.from], plan.points[step.to]];
  if (a?.kind === 'above' && b?.kind === 'split') return `Plunge down to split ${b.split + 1}`;
  if (a?.kind === 'split' && b?.kind === 'above') return `Back up from split ${a.split + 1}`;
  if (a?.kind === 'level' && b?.kind === 'split') return `Lead in across to split ${b.split + 1}`;
  if (a?.kind === 'split' && b?.kind === 'level') return `Lead out from split ${a.split + 1}`;
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

/** What is being dragged in the tree. */
type Drag = { kind: 'step'; i: number } | { kind: 'group'; id: string } | { kind: 'bar' };
/** Where it would land: before step `before` (steps.length = the end), in folder `group`. */
interface Drop {
  before: number;
  group: string | undefined;
}

export function PlanPanel(props: Props) {
  const { plan, result, onChange, selected, onSelect, overrides, onOverride, units } = props;
  const n = result.stats.segments;
  const topo = result.topology ?? n;
  const steps = plan.steps;
  const groups = plan.groups ?? [];
  const gapsBefore = new Set(result.gaps.map((g) => g.before));
  const stepWarn = new Set(result.warnings.flatMap((w) => (w.step === undefined ? [] : [w.step])));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const pairs = result.pairs;
  const groupOfPair = (p: number) => groups.find((g) => g.pair === p);

  const doDrop = (d: Drop) => {
    if (!drag) return;
    if (drag.kind === 'bar') props.onBar(d.before);
    else if (drag.kind === 'step') onChange(moveStepTo(plan, drag.i, d.before, d.group));
    else onChange(moveGroupTo(plan, drag.id, d.before));
    setDrag(null);
    setDrop(null);
  };
  /** Drop-target handlers for a spot in the list. */
  const target = (d: Drop) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return;
      // folders only go between top-level items
      if (drag.kind === 'group' && d.group) return;
      e.preventDefault();
      e.stopPropagation();
      if (drop?.before !== d.before || drop?.group !== d.group) setDrop(d);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      doDrop(d);
    },
  });
  const dragSource = (d: Drag) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', d.kind);
      setDrag(d);
    },
    onDragEnd: () => {
      setDrag(null);
      setDrop(null);
    },
  });
  const isDropAt = (before: number, group?: string) => !!drag && drop?.before === before && drop?.group === group;

  const bar = (
    <div key="bar" className={`rollback ${props.bar < steps.length ? 'up' : ''}`} {...dragSource({ kind: 'bar' })} title="Drag up to see the cut only up to here; new steps go here">
      <span className="grip">⠿</span>
      <span>{props.bar < steps.length ? `Rolled back: showing steps 1–${props.bar}` : 'Rollback bar: drag up to step through the cut'}</span>
      {props.bar < steps.length && (
        <button className="muted" onClick={() => props.onBar(steps.length)}>
          Roll to end
        </button>
      )}
    </div>
  );

  const stepRow = (s: PlanStep, i: number) => (
    <li key={s.id} {...target({ before: i, group: s.group })} className={isDropAt(i, s.group) ? 'drop-before' : ''}>
      {props.bar === i && bar}
      {gapsBefore.has(i) && <GapRow before={i} plan={plan} n={topo} onChange={onChange} />}
      <div
        className={`step ${s.kind === 'line' ? s.speed : s.kind === 'jog' ? 'jog' : 'segment'} ${selected === i ? 'selected' : ''} ${stepWarn.has(i) ? 'warned' : ''} ${i >= props.bar ? 'rolled' : ''}`}
        onClick={() => onSelect(selected === i ? null : i)}
        {...dragSource({ kind: 'step', i })}
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
          {s.kind === 'jog' && (
            <button
              className="speed"
              onClick={() => {
                const p = clonePlan(plan);
                const j = p.steps[i];
                if (j.kind === 'jog') j.route = j.route === 'over' ? 'straight' : 'over';
                onChange({ ...p, template: 'custom' });
              }}
              title="Over the block (up, across, down) or straight"
            >
              {s.route === 'over' ? 'over' : 'direct'}
            </button>
          )}
          {s.kind !== 'jog' && (
            <button onClick={() => onChange(reverseStep(plan, i))} title="Reverse direction">
              ⇄
            </button>
          )}
          <button onClick={() => onChange(removeStep(plan, i))} title="Remove step">
            ✕
          </button>
        </span>
      </div>
      {selected === i && s.kind === 'segment' && (
        <div className="step-override">
          <span>Segment {s.seg + 1}:</span>
          <label>
            kerf
            <OptNum label={`segment ${s.seg + 1} kerf`} placeholder="job" value={overrides[s.seg]?.kerf} onChange={(v) => onOverride(s.seg, { ...overrides[s.seg], kerf: v })} />
          </label>
          <label>
            speed
            <OptNum label={`segment ${s.seg + 1} speed`} placeholder="job" value={overrides[s.seg]?.speed} onChange={(v) => onOverride(s.seg, { ...overrides[s.seg], speed: v })} />
          </label>
          <small className="hint" style={{ margin: 0 }}>
            {units}, {units}/min · blank = job value
          </small>
        </div>
      )}
    </li>
  );

  // the tree: top-level steps and folders, in step order (empty folders at the end)
  const items: React.ReactNode[] = [];
  for (let i = 0; i < steps.length; ) {
    const g = steps[i].group;
    const group = g ? groups.find((x) => x.id === g) : undefined;
    if (!group) {
      items.push(stepRow(steps[i], i));
      i++;
      continue;
    }
    let j = i;
    while (j < steps.length && steps[j].group === g) j++;
    const first = i;
    const end = j;
    const open = !collapsed.has(group.id);
    const pairNo = group.pair;
    items.push(
      <li key={group.id} className={`folder ${isDropAt(first) ? 'drop-before' : ''} ${isDropAt(end, group.id) ? 'drop-into' : ''}`}>
        {props.bar === first && bar}
        <div
          className="folder-head"
          {...dragSource({ kind: 'group', id: group.id })}
          // a step dropped on the header goes into the folder (at its end); a folder or the bar goes before it
          {...(drag?.kind === 'step' ? target({ before: end, group: group.id }) : target({ before: first, group: undefined }))}
        >
          <button className="muted twisty" onClick={() => setCollapsed((c) => new Set(c.has(group.id) ? [...c].filter((x) => x !== group.id) : [...c, group.id]))}>
            {open ? '▾' : '▸'}
          </button>
          {pairNo !== undefined && <span className="swatch" style={{ background: pairColor(pairNo, 'var(--root)') }} />}
          {renaming === group.id ? (
            <input
              autoFocus
              defaultValue={group.name}
              onBlur={(e) => {
                onChange(renameGroup(plan, group.id, e.target.value || group.name));
                setRenaming(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span className="folder-name" onDoubleClick={() => setRenaming(group.id)} title="Double-click to rename">
              {group.name}
            </span>
          )}
          <small className="hint">
            {end - first} step{end - first === 1 ? '' : 's'}
          </small>
          <span className="step-actions">
            <button onClick={() => setRenaming(group.id)} title="Rename">
              ✎
            </button>
            <button onClick={() => onChange(removeGroup(plan, group.id, false))} title="Remove the folder, keep its steps">
              ⇱
            </button>
            <button onClick={() => onChange(removeGroup(plan, group.id, true))} title="Delete the folder and its steps">
              ✕
            </button>
          </span>
        </div>
        {open && <ol className="steps nested">{steps.slice(first, end).map((s, k) => stepRow(s, first + k))}</ol>}
        {!open && props.bar > first && props.bar < end && bar}
      </li>,
    );
    i = j;
  }
  for (const g of groups.filter((x) => !steps.some((s) => s.group === x.id))) {
    items.push(
      <li key={g.id} className={`folder ${isDropAt(steps.length, g.id) ? 'drop-into' : ''}`}>
        <div className="folder-head" {...target({ before: steps.length, group: g.id })}>
          <span className="folder-name">{g.name}</span>
          <small className="hint">empty: drag steps here</small>
          <span className="step-actions">
            <button onClick={() => onChange(removeGroup(plan, g.id, true))} title="Delete the folder">
              ✕
            </button>
          </span>
        </div>
      </li>,
    );
  }

  return (
    <>
      <section>
        <h2>Templates</h2>
        <small className="hint">Pick a contour pair (here or by clicking it on the canvas), then a template. Its steps go in a folder for that pair.</small>
        <div className="pair-chips">
          {pairs.map((_, i) => (
            <button key={i} className={props.pair === i ? 'active' : ''} onClick={() => props.onPair(props.pair === i ? null : i)}>
              <span className="swatch" style={{ background: pairColor(i, 'var(--root)') }} />
              {i === 0 ? 'Outline' : `Pair ${i + 1}`} {groupOfPair(i) ? '✓' : ''}
            </button>
          ))}
        </div>
        <div className="row-buttons">
          {(['loop', 'loop-reverse', 'le-te'] as PairTemplate[]).map((t) => (
            <button
              key={t}
              disabled={props.pair === null || (t === 'le-te' && props.pair !== 0)}
              onClick={() => props.onTemplate(t)}
              title={
                t === 'le-te'
                  ? 'Outline only: upper surface LE→TE, jog back over the block, lower surface LE→TE'
                  : props.pair !== null && props.pair > 0
                    ? 'Plunge down from above its start, cut round, back up'
                    : 'Up from home to the start, round the outline, back out'
              }
            >
              {TEMPLATE_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="row-buttons">
          <button className="primary" onClick={props.onSequenceAll} title="Holes first (front to back, plunged in from above), then the outline, then home">
            Sequence all
          </button>
          <button className="danger" disabled={!steps.length} onClick={props.onClear}>
            Clear sequence
          </button>
        </div>
      </section>

      <section>
        <h2>Sequence</h2>
        <div className="row-buttons insert-bar">
          <span className="hint">Insert at the bar:</span>
          <button className={props.pick === 'jog' ? 'active' : ''} onClick={() => props.onPick(props.pick === 'jog' ? null : 'jog')} title="Then click a split marker on the canvas">
            + Jog to split
          </button>
          <button onClick={props.onJogHome}>+ Jog home</button>
          <button className={props.pick === 'line' ? 'active' : ''} onClick={() => props.onPick(props.pick === 'line' ? null : 'line')} title="Then click points on the canvas; click a split to end there">
            + Cut line
          </button>
          <button className={props.pick === 'segment' ? 'active' : ''} onClick={() => props.onPick(props.pick === 'segment' ? null : 'segment')} title="Then click a profile segment on the canvas">
            + Segment
          </button>
          <button onClick={() => onChange(addGroup(plan, `Folder ${groups.length + 1}`).plan)}>+ Folder</button>
        </div>
        {!steps.length && <small className="hint">Nothing sequenced yet.</small>}
        <ol className="steps">
          {items}
          <li {...target({ before: steps.length, group: undefined })} className={`end-drop ${isDropAt(steps.length) ? 'drop-before' : ''}`}>
            {gapsBefore.has(steps.length) && <GapRow before={steps.length} plan={plan} n={topo} onChange={onChange} />}
            {props.bar >= steps.length && bar}
          </li>
        </ol>
        <small className="hint">
          Drag steps and folders to reorder them (drop a step on a folder's name to put it in). On the canvas: click a step's path to select it; click a
          split marker to run out or out-and-back; click a line to switch cut/jog, add a point or delete it.
        </small>
      </section>
    </>
  );
}
