import type { CutResult } from '../core/cut/pipeline';
import type { LoadedProfile } from '../core/io/loadProfile';
import type { SourceFile } from '../core/io/project';
import type { CutPlan } from '../core/plan/model';
import { loopPlan, type Rect } from '../core/plan/templates';
import type { JobSettings, MachinePreset, MaterialPreset, SegmentOverride } from '../core/types';
import { NumberField, SelectField } from './Fields';
import { PlanPanel } from './PlanPanel';
import { download } from './PresetEditor';
import { TransformPanel } from './TransformPanel';
import type { PresetOrigin } from './usePresets';

/** Everything the pages read and change; owned by App. */
export interface PageCtx {
  job: JobSettings;
  patch: (p: Partial<JobSettings>) => void;
  result: CutResult | null;
  plan: CutPlan | null;
  machine: MachinePreset;
  material: MaterialPreset;
  machines: MachinePreset[];
  materials: MaterialPreset[];
  origin: (kind: 'machine' | 'material', id: string) => PresetOrigin;
  setMachineId: (id: string) => void;
  applyMaterial: (m: MaterialPreset) => void;
  openEditor: (kind: 'machine' | 'material') => void;
  rootFile: SourceFile | null;
  tipFile: SourceFile | null;
  root: LoadedProfile | null;
  tip: LoadedProfile | null;
  loadRoot: (f: SourceFile) => void;
  loadTip: (f: SourceFile) => void;
  loadExample: () => void;
  fitBlock: () => Rect;
  clearance: number;
  setClearance: (v: number) => void;
  outBack: number;
  setOutBack: (v: number) => void;
  selectedStep: number | null;
  setSelectedStep: (i: number | null) => void;
  applyLeTe: () => void;
  baseName: string;
  setNotice: (s: string | null) => void;
  /** Clear profiles and all job settings (asks first). */
  resetProject: () => void;
}

function FileRow(props: { label: string; color: string; file: SourceFile | null; loaded: LoadedProfile | null; onLoad: (f: SourceFile) => void }) {
  const p = props.loaded;
  return (
    <div className="file-card">
      <div className="file-row">
        <span>
          <span className="swatch" style={{ background: props.color }} />
          {props.label}
        </span>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <input
            type="file"
            accept=".dxf,.DXF"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) props.onLoad({ name: f.name, text: await f.text() });
              e.target.value = '';
            }}
          />
          <span className="name" style={{ flex: 1 }}>{props.file?.name ?? 'No file'}</span>
          <span role="button" tabIndex={0} className="file-btn">
            Open…
          </span>
        </label>
      </div>
      {p && (
        <small className="hint">
          {p.profile ? `Closed outline, ${p.profile.breaks.length} entities` : 'No closed outline found'}
          {p.fileUnits ? ` · file units: ${p.fileUnits}` : ' · file units not stated'}
        </small>
      )}
    </div>
  );
}

function presetOptions(list: { id: string; name: string }[], origin: (id: string) => string) {
  const groups: [string, string][] = [
    ['repo', 'Team (repo)'],
    ['local', 'This browser'],
    ['project', 'From a project'],
  ];
  return groups.map(([key, label]) => {
    const items = list.filter((p) => origin(p.id) === key);
    return items.length ? (
      <optgroup key={key} label={label}>
        {items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </optgroup>
    ) : null;
  });
}

/** One line describing what the selected material sets (cut speed, kerf, power). */
function materialSummary(job: JobSettings, u: string): string {
  const kerf =
    job.kerf.mode === 'auto' && job.kerfTable.length
      ? `kerf from a ${job.kerfTable.length}-row speed table`
      : `kerf ${job.kerf.root} root / ${job.kerf.tip} tip`;
  const power = job.wireWatts != null ? `${job.wireWatts} W` : 'no wire power set';
  return `Cuts at ${job.cutSpeed} ${u}/min · ${kerf} ${u} · ${power}. Change these in the material (Edit…).`;
}

// ---------------------------------------------------------------- 1. Import
export function ImportPage(c: PageCtx) {
  return (
    <>
      <section>
        <h2>Profiles</h2>
        <small className="hint">Load the root and tip outlines as DXF (e.g. exported from SolidWorks). Both need to be closed outlines.</small>
        <small className="hint">
          On the right, choose which geometry to cut: click an entity to include or exclude it, drag a box to include everything inside (Shift-drag
          excludes). Text is shown but never cut. <i>Auto pick</i> uses the largest closed outline.
        </small>
        <FileRow label="Root" color="var(--root)" file={c.rootFile} loaded={c.root} onLoad={c.loadRoot} />
        <FileRow label="Tip" color="var(--tip)" file={c.tipFile} loaded={c.tip} onLoad={c.loadTip} />
        <div className="row-buttons">
          <button onClick={c.loadExample}>Load V-tail example</button>
          <button className="danger" disabled={!c.rootFile && !c.tipFile} onClick={c.resetProject} title="Clear both profiles and every job setting (presets are kept)">
            Reset project
          </button>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- 2. Setup
export function SetupPage(c: PageCtx) {
  const { job, patch, machine, material } = c;
  const u = machine.units;
  return (
    <>
      <section>
        <h2>Machine &amp; material</h2>
        <label className="field">
          <span>Machine</span>
          <span className="pick">
            <select value={machine.id} onChange={(e) => c.setMachineId(e.target.value)}>
              {presetOptions(c.machines, (id) => c.origin('machine', id))}
            </select>
            <button onClick={() => c.openEditor('machine')} title="Edit or copy this machine">
              Edit…
            </button>
          </span>
        </label>
        <label className="field">
          <span>Material</span>
          <span className="pick">
            <select value={material.id} onChange={(e) => c.applyMaterial(c.materials.find((m) => m.id === e.target.value)!)}>
              {presetOptions(c.materials, (id) => c.origin('material', id))}
            </select>
            <button onClick={() => c.openEditor('material')} title="Edit or copy this material (kerf table, kerf test, dwell, wire power)">
              Edit…
            </button>
          </span>
        </label>
        <small className="hint">{materialSummary(job, u)}</small>
      </section>


      <section>
        <h2>Block on the machine ({u})</h2>
        <NumberField label="Block span" value={job.span} min={0} onChange={(v) => patch({ span: v })} hint="Distance from the root face to the tip face" />
        <NumberField label="Root face from left carriage" value={job.rootFaceFromLeft} onChange={(v) => patch({ rootFaceFromLeft: v })} />
        <SelectField label="Root on" value={job.rootSide} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} onChange={(v) => patch({ rootSide: v })} />
        <div className="row-buttons">
          <button title="Cut the opposite-hand panel from the same files: puts the root on the other carriage" onClick={() => patch({ rootSide: job.rootSide === 'left' ? 'right' : 'left' })}>
            Mirror L/R
          </button>
          <button onClick={() => patch({ rootFaceFromLeft: (machine.carriageSpacing - job.span) / 2 })}>
            Center block ({machine.carriageSpacing} {u} wire)
          </button>
        </div>
        <NumberField label="Part offset X" value={job.offset.x} onChange={(v) => patch({ offset: { ...job.offset, x: v } })} hint="Where the profiles sit in machine X/Y" />
        <NumberField label="Part offset Y" value={job.offset.y} onChange={(v) => patch({ offset: { ...job.offset, y: v } })} />
      </section>

      <section>
        <h2>Foam block outline ({u})</h2>
        <NumberField label="Left edge X" value={job.block.x} onChange={(v) => patch({ block: { ...job.block, x: v } })} />
        <NumberField label="Bottom Y" value={job.block.y} onChange={(v) => patch({ block: { ...job.block, y: v } })} />
        <NumberField label="Width" value={job.block.w} min={0} onChange={(v) => patch({ block: { ...job.block, w: v } })} />
        <NumberField label="Height" value={job.block.h} min={0} onChange={(v) => patch({ block: { ...job.block, h: v } })} hint="0 = no block; jog checks are off" />
        <button onClick={() => patch({ block: c.fitBlock() })}>Fit block to part</button>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- 3. Transform
export function TransformPage(c: PageCtx) {
  const { job, patch } = c;
  const u = c.machine.units;
  const distance = job.profile.distance ?? job.span;
  const inset = job.profile.inset ?? (job.span - distance) / 2;
  return (
    <>
      <section>
        <h2>Profile placement ({u})</h2>
        <small className="hint">
          Where the root and tip profiles sit along the wire, inside the {job.span} {u} block. By default the profiles are the block's faces.
        </small>
        <NumberField
          label="Profile distance"
          value={distance}
          min={0}
          onChange={(v) => patch({ profile: { ...job.profile, distance: v } })}
          hint="Distance between the root and tip profiles (the panel span)"
        />
        <NumberField
          label="Root profile inset"
          value={inset}
          onChange={(v) => patch({ profile: { ...job.profile, inset: v } })}
          hint="From the block's root face to the root profile"
        />
        <div className="row-buttons">
          <button disabled={job.profile.inset === null} onClick={() => patch({ profile: { ...job.profile, inset: null } })} title="Same gap on both sides">
            Center in block
          </button>
          <button disabled={job.profile.distance === null && job.profile.inset === null} onClick={() => patch({ profile: { distance: null, inset: null } })}>
            Profiles on block faces
          </button>
        </div>
      </section>
      <TransformPanel value={job.transforms} units={u} onChange={(t, opts) => patch({ transforms: t, ...(opts?.resetPlan ? { plan: null } : {}) })} />
    </>
  );
}

// ---------------------------------------------------------------- 4. Segment
export function SegmentPage(c: PageCtx) {
  const { job, patch } = c;
  const u = c.machine.units;
  return (
    <>
      <section>
        <h2>Sync points</h2>
        <small className="hint">
          Segment <b>N</b> on the root is cut together with segment <b>N</b> on the tip. On the canvas: click a profile outline to add a split or a pin
          (the matching one is added on the other profile), drag markers to slide them, click a marker for more options.
        </small>
        <small className="hint">{job.sync ? 'Splits are edited by hand.' : 'Splits are automatic (entity boundaries + sharp corners).'}</small>
        <button
          disabled={!job.sync}
          onClick={() => {
            patch({ sync: null, plan: null });
            c.setNotice(null);
          }}
        >
          Reset splits &amp; pins to automatic
        </button>
        <NumberField
          label="Corner split angle (°)"
          value={job.cornerSplitDeg}
          min={1}
          onChange={(v) => patch({ cornerSplitDeg: v, sync: null, plan: null })}
          hint="Corners sharper than this become automatic splits. Changing it resets splits, pins and the plan."
        />
      </section>
      <section>
        <h2>Point spacing</h2>
        <SelectField
          label="Spacing"
          value={job.sampling.mode}
          options={[{ value: 'adaptive', label: 'Curvature-adaptive' }, { value: 'uniform', label: 'Uniform' }]}
          onChange={(v) => patch({ sampling: { ...job.sampling, mode: v } })}
        />
        {job.sampling.mode === 'uniform' ? (
          <NumberField label={`Step (${u})`} value={job.sampling.step} min={0.001} onChange={(v) => v > 0 && patch({ sampling: { ...job.sampling, step: v } })} />
        ) : (
          <>
            <NumberField label={`Tolerance (${u})`} value={job.sampling.tolerance} min={0.0001} step={0.0005} onChange={(v) => v > 0 && patch({ sampling: { ...job.sampling, tolerance: v } })} />
            <NumberField label={`Max step (${u})`} value={job.sampling.maxStep} min={0.001} onChange={(v) => v > 0 && patch({ sampling: { ...job.sampling, maxStep: v } })} />
          </>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- 5. Sequence
export function SequencePage(c: PageCtx) {
  const { job, patch, plan, result } = c;
  const u = c.machine.units;
  if (!plan || !result) return null;
  return (
    <>
      <PlanPanel
        overrides={job.segmentOverrides}
        onOverride={(seg, o: SegmentOverride) => {
          const next = { ...job.segmentOverrides };
          if (o.kerf === undefined && o.speed === undefined) delete next[seg];
          else next[seg] = o;
          patch({ segmentOverrides: next });
        }}
        units={u}
        plan={plan}
        result={result}
        onChange={(p) => patch({ plan: p })}
        onLoop={(reversed) => patch({ plan: loopPlanFor(result, reversed) })}
        onLeTe={c.applyLeTe}
        selected={c.selectedStep}
        onSelect={c.setSelectedStep}
      />
      <section>
        <h2>Template &amp; run-out settings</h2>
        <NumberField label={`Template clearance (${u})`} value={c.clearance} min={0} onChange={c.setClearance} hint="How far outside the block the LE→TE template puts run-in/out and jog points" />
        <NumberField label={`Out-and-back distance (${u})`} value={c.outBack} min={0} onChange={c.setOutBack} hint="How far past the split an out-and-back runs out" />
        <small className="hint">
          Jogs run at {c.machine.jogSpeed} {u}/min (machine preset).
        </small>
      </section>
    </>
  );
}

const loopPlanFor = (result: CutResult, reversed: boolean) => loopPlan(result.stats.segments, reversed);

// ---------------------------------------------------------------- 6. Preview
export function PreviewPage(c: PageCtx) {
  const r = c.result;
  return (
    <section>
      <h2>Preview cut path</h2>
      <small className="hint">
        The 3D view shows the machine, the foam block, both profiles, the surface the wire cuts and both carriage paths (green = root side, purple = tip side). Press ▶ to play the cut (pick a
        speed on the right); drag the slider to scrub. Use the checkboxes to hide parts, and the 2D / 3D switch to go back to the flat view.
      </small>
      {r && (
        <ul className="summary">
          <li>
            Cut time <b>{r.stats.cutMinutes.toFixed(1)} min</b>
          </li>
          <li>
            Fastest carriage{' '}
            <b>
              {r.stats.maxCarriageSpeed.toFixed(2)} {c.machine.units}/min
            </b>{' '}
            (cap {c.machine.maxSpeed})
          </li>
          <li>
            Moves <b>{r.stats.moves}</b>
          </li>
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 7. Export
export function ExportPage(c: PageCtx & { fileName: string; setFileName: (s: string) => void }) {
  const { job, patch, result: r, machine } = c;
  const lines = r?.gcode ? r.gcode.split('\n') : [];
  const SHOW = 300;
  return (
    <>
      {job.wireWatts != null ? (
        <div className="callout">
          Before cutting, set the hot-wire power to <strong>{job.wireWatts} W</strong>
          <small>from material “{c.material.name}”</small>
        </div>
      ) : (
        <div className="callout warn">
          No wire power is set for “{c.material.name}”. Add it in Define Setup → Material → Edit…, or set the power by hand before cutting.
        </div>
      )}
      <section>
        <h2>Corner dwell</h2>
        <label className="check">
          <input type="checkbox" checked={job.dwell.enabled} onChange={(e) => patch({ dwell: { ...job.dwell, enabled: e.target.checked } })} />
          Pause at sharp corners
        </label>
        {job.dwell.enabled && (
          <>
            <NumberField label="Corners sharper than (°)" value={job.dwell.angleDeg} min={1} onChange={(v) => patch({ dwell: { ...job.dwell, angleDeg: v } })} />
            <NumberField label="Pause (s)" value={job.dwell.seconds} min={0} onChange={(v) => patch({ dwell: { ...job.dwell, seconds: v } })} />
            <small className="hint">
              Sent as G4 P{machine.dwellUnits === 'ms' ? ' in milliseconds' : ' in seconds'} (machine setting). {r ? `${r.stats.dwells} pause${r.stats.dwells === 1 ? '' : 's'} in this cut.` : ''}
            </small>
          </>
        )}
      </section>

      <section>
        <h2>Summary</h2>
        {r && (
          <ul className="summary">
            <li>
              Machine <b>{machine.name}</b>, material <b>{c.material.name}</b>
            </li>
            <li>
              {r.stats.segments} segments, {c.plan?.steps.length ?? 0} plan steps, {r.stats.moves} moves
            </li>
            <li>
              Cut time <b>{r.stats.cutMinutes.toFixed(1)} min</b>
              {r.stats.dwells ? ` (incl. ${r.stats.dwells} dwells)` : ''}
            </li>
            <li>
              {machine.feedMode} feed, axes {machine.axisOrder.map((k) => machine.axes[k]).join(' ')}, {machine.units === 'in' ? 'inches' : 'mm'}
            </li>
          </ul>
        )}
      </section>

      <section>
        <h2>Export</h2>
        <label className="field">
          <span>File name</span>
          <input value={c.fileName} onChange={(e) => c.setFileName(e.target.value)} />
        </label>
        <button className="primary wide" disabled={!r?.ok} onClick={() => r && download(c.fileName.endsWith('.nc') ? c.fileName : `${c.fileName}.nc`, r.gcode)}>
          Export G-code
        </button>
        {!r?.ok && <small className="hint">Fix the problems listed below to export.</small>}
      </section>

      {lines.length > 0 && (
        <section>
          <h2>G-code ({lines.length - 1} lines)</h2>
          <pre className="gcode">
            {lines.slice(0, SHOW).join('\n')}
            {lines.length > SHOW ? `\n… ${lines.length - SHOW} more lines` : ''}
          </pre>
        </section>
      )}
    </>
  );
}

