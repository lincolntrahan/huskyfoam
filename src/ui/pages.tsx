import type { CutResult } from '../core/cut/pipeline';
import type { LoadedProfile } from '../core/io/loadProfile';
import type { SourceFile } from '../core/io/project';
import type { CutPlan } from '../core/plan/model';
import { loopPlan, type Rect } from '../core/plan/templates';
import type { JobSettings, MachinePreset, MaterialPreset, SegmentOverride } from '../core/types';
import type { KerfSide } from '../core/cut/contours';
import { defaultLayout, fitBlockSize, type AlignH, type AlignV, type Layout } from '../core/cut/placement';
import { NumberField, SelectField } from './Fields';
import { PlanPanel } from './PlanPanel';
import { download } from './PresetEditor';
import { TransformPanel } from './TransformPanel';
import type { PresetOrigin } from './usePresets';

/** Everything the pages read and change; owned by App. */
export interface PageCtx {
  job: JobSettings;
  /** The job with its layout resolved (profile planes, part offset, block). */
  placed: JobSettings;
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
          {p.profile ? contourSummary(p) : 'No closed outline found'}
          {p.fileUnits ? ` · file units: ${p.fileUnits}` : ' · file units not stated'}
        </small>
      )}
    </div>
  );
}

/** "Closed outline, 7 entities" or "3 contours: outline + 2 holes, 1 open". */
export function contourSummary(p: LoadedProfile): string {
  const n = p.contours.length;
  if (n <= 1) return p.profile && p.profile.closed !== false ? `Closed outline, ${p.profile.breaks.length} entities` : 'One open contour';
  const holes = p.contours.slice(1).filter((c) => c.closed !== false).length;
  const open = n - 1 - holes;
  const parts = [holes ? `${holes} hole${holes === 1 ? '' : 's'}` : '', open ? `${open} open` : ''].filter(Boolean);
  return `${n} contours: outline + ${parts.join(', ')}`;
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

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

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
        <small className="hint">
          Load the root and tip outlines as DXF (e.g. exported from SolidWorks). Each needs a closed outer outline; holes inside it (spar channels) and
          open lines are cut too.
        </small>
        <small className="hint">
          On the right, choose which geometry to cut: click an entity to include or exclude it, drag a box to include everything inside (Shift-drag
          excludes). Text is shown but never cut. <i>Auto pick</i> uses the largest closed outline and everything inside it.
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

// ---------------------------------------------------------------- 2. Arrange profiles
export function TransformPage(c: PageCtx) {
  const { job, patch } = c;
  const u = c.machine.units;
  const distance = job.profile.distance ?? job.span;
  return (
    <>
      <section>
        <h2>Profile spacing ({u})</h2>
        <small className="hint">
          Arrange the root and tip relative to each other here. Where the part ends up on the machine follows from <i>Place in Machine</i>: it sits the
          floor offset above Y = 0 and as close to X = 0 as the carriages allow.
        </small>
        <NumberField
          label="Distance between profiles"
          value={distance}
          min={0}
          onChange={(v) => v > 0 && patch({ profile: { distance: v, inset: null } })}
          hint="Along the wire, root plane to tip plane (the panel span)"
        />
        <small className="hint">Drag a profile on the canvas to move it relative to the other one (it updates Move X / Y below).</small>
      </section>
      <TransformPanel value={job.transforms} units={u} onChange={(t, opts) => patch({ transforms: t, ...(opts?.resetPlan ? { plan: null } : {}) })} />
    </>
  );
}

// ---------------------------------------------------------------- 3. Place in machine
const ALONG_WIRE = [
  { value: 'center', label: 'Profiles centred' },
  { value: 'left', label: 'Left profile on the left face' },
  { value: 'right', label: 'Right profile on the right face' },
] as const;
const ALONG_CHORD = [
  { value: 'center', label: 'Profiles centred' },
  { value: 'left', label: 'Profiles against the −X side' },
  { value: 'right', label: 'Profiles against the +X side' },
] as const;
const VERTICAL = [
  { value: 'middle', label: 'Profiles in the middle' },
  { value: 'bottom', label: 'Profiles on the bottom face' },
  { value: 'top', label: 'Profiles against the top face' },
] as const;

export function SetupPage(c: PageCtx) {
  const { job, patch, machine, placed } = c;
  const u = machine.units;
  const L = job.layout ?? defaultLayout(machine, job.profile.distance ?? job.span);
  const setL = (p: Partial<Layout>) => patch({ layout: { ...L, ...p } });
  const distance = job.profile.distance ?? job.span;
  const outlines = c.result?.pairs.flatMap((p) => [...p.pts.root, ...p.pts.tip]) ?? [];
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const blockSet = placed.block.w > 0 && placed.block.h > 0;
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
            <select value={c.material.id} onChange={(e) => c.applyMaterial(c.materials.find((m) => m.id === e.target.value)!)}>
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
        <h2>Profiles on the machine ({u})</h2>
        <small className="hint">
          Carriages are {machine.carriageSpacing} {u} apart and the profiles {r3(distance)} {u} apart. Measure from either carriage; the other side
          follows.
        </small>
        <div className="dual">
          <NumberField label="Left carriage to left profile" value={round6(L.profileFromLeft)} onChange={(v) => setL({ profileFromLeft: v })} />
          <NumberField
            label="Right carriage to right profile"
            value={round6(machine.carriageSpacing - distance - L.profileFromLeft)}
            onChange={(v) => setL({ profileFromLeft: machine.carriageSpacing - distance - v })}
          />
        </div>
        <SelectField
          label="Root profile on"
          value={job.rootSide}
          options={[
            { value: 'left', label: 'Left (tip on right)' },
            { value: 'right', label: 'Right (tip on left)' },
          ]}
          onChange={(v) => patch({ rootSide: v })}
        />
        <div className="row-buttons">
          <button title="Cut the opposite-hand panel from the same files: swaps which carriage gets the root" onClick={() => patch({ rootSide: job.rootSide === 'left' ? 'right' : 'left' })}>
            Mirror L/R
          </button>
          <button onClick={() => setL({ profileFromLeft: (machine.carriageSpacing - distance) / 2 })}>Center between carriages</button>
        </div>
        <NumberField label="Height above floor" value={L.floor} onChange={(v) => setL({ floor: v })} hint="Lowest profile point above Y = 0" />
        <small className="hint">
          The part is pushed toward X = {machine.travel.x[0]} until a carriage would pass it: part offset ({r3(placed.offset.x)}, {r3(placed.offset.y)}).
        </small>
      </section>

      <section>
        <h2>Foam block ({u})</h2>
        <NumberField label="Width (X, along the chord)" value={L.block.w} min={0} onChange={(v) => setL({ block: { ...L.block, w: v } })} />
        <NumberField label="Height (Y)" value={L.block.h} min={0} onChange={(v) => setL({ block: { ...L.block, h: v } })} />
        <NumberField
          label="Length (along the wire)"
          value={L.block.len}
          min={0}
          onChange={(v) => setL({ block: { ...L.block, len: v } })}
          hint="0 = the profile distance"
        />
        <SelectField label="Along the wire" value={L.alongWire} options={[...ALONG_WIRE]} onChange={(v) => setL({ alongWire: v as AlignH })} />
        <SelectField label="Along the chord" value={L.alongChord} options={[...ALONG_CHORD]} onChange={(v) => setL({ alongChord: v as AlignH })} />
        <SelectField label="Vertical" value={L.vertical} options={[...VERTICAL]} onChange={(v) => setL({ vertical: v as AlignV })} />
        <button disabled={!outlines.length} onClick={() => setL({ block: fitBlockSize(placed, outlines, u === 'mm' ? 5 : 0.2) })}>
          Fit block to profiles
        </button>
        <small className="hint">
          {blockSet
            ? `Block X ${r3(placed.block.x)} to ${r3(placed.block.x + placed.block.w)}, Y ${r3(placed.block.y)} to ${r3(placed.block.y + placed.block.h)}; faces ${r3(placed.rootFaceFromLeft)} and ${r3(placed.rootFaceFromLeft + placed.span)} from the left carriage.`
            : 'Width or height 0 = no block: jog-through-foam checks are off.'}
        </small>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- 4. Segment
const kind = (closed: boolean) => (closed ? 'closed' : 'open');
const SIDE_LABEL: Record<KerfSide, string> = { auto: 'Auto', outside: 'Outside', inside: 'Inside', left: 'Left of path', right: 'Right of path', none: 'None (on the line)' };

/** Pair root contours with tip contours, and pick each pair's kerf side. Shown when a profile has several contours. */
function ContoursSection(c: PageCtx) {
  const { job, patch, result } = c;
  const roots = c.root?.contours ?? [];
  const tips = c.tip?.contours ?? [];
  if (roots.length < 2 && tips.length < 2) return null;
  const pairOf = (r: number) => result?.pairs.find((p) => p.root === r);
  const current = roots.map((_, r) => pairOf(r)?.tip ?? job.contours.pairs?.[r] ?? -1);
  const setPair = (r: number, t: number) => {
    const pairs = current.slice();
    // a tip contour pairs with one root contour at a time
    pairs.forEach((x, i) => {
      if (i !== r && x === t) pairs[i] = -1;
    });
    pairs[r] = t;
    const sync = { ...job.contours.sync };
    delete sync[r];
    patch({ contours: { ...job.contours, pairs, sync }, plan: null });
  };
  const setSide = (r: number, side: KerfSide) => patch({ contours: { ...job.contours, kerfSide: { ...job.contours.kerfSide, [r]: side } } });
  return (
    <section>
      <h2>Contours</h2>
      <small className="hint">
        Each root contour is cut with a tip contour. Holes and open lines are paired by where they sit in the outline; change a pairing here if
        the guess is wrong. The default plan cuts in from the nearest point of the outline, around each contour, and back out.
      </small>
      <table className="contours">
        <thead>
          <tr>
            <th>Root</th>
            <th>Tip</th>
            <th>Kerf side</th>
          </tr>
        </thead>
        <tbody>
          {roots.map((p, r) => {
            const closed = p.closed !== false;
            const pr = pairOf(r);
            const sides: KerfSide[] = closed ? ['auto', 'outside', 'inside', 'none'] : ['auto', 'left', 'right', 'none'];
            const chosen = job.contours.kerfSide[r] ?? 'auto';
            return (
              <tr key={r}>
                <td>
                  {r + 1} <small className="hint">{r === 0 ? 'outer' : kind(closed)}</small>
                </td>
                <td>
                  {r === 0 ? (
                    <span>1</span>
                  ) : (
                    <select value={current[r]} onChange={(e) => setPair(r, Number(e.target.value))}>
                      <option value={-1}>not cut</option>
                      {tips.map((q, t) =>
                        t === 0 ? null : (
                          <option key={t} value={t}>
                            {t + 1} ({kind(q.closed !== false)})
                          </option>
                        ),
                      )}
                    </select>
                  )}
                </td>
                <td>
                  <select value={chosen} disabled={!pr} onChange={(e) => setSide(r, e.target.value as KerfSide)}>
                    {sides.map((s) => (
                      <option key={s} value={s}>
                        {s === 'auto' && pr ? `Auto (${pr.autoKerfSide})` : SIDE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button disabled={!job.contours.pairs} onClick={() => patch({ contours: { ...job.contours, pairs: null, sync: {} }, plan: null })}>
        Pair automatically
      </button>
      <small className="hint">Open contours are left or right of the direction they were drawn in; turn on the kerf layer to check the side.</small>
    </section>
  );
}

export function SegmentPage(c: PageCtx) {
  const { job, patch } = c;
  const u = c.machine.units;
  const hand = !!job.sync || Object.keys(job.contours.sync).length > 0;
  return (
    <>
      <ContoursSection {...c} />
      <section>
        <h2>Sync points</h2>
        <small className="hint">
          Segment <b>N</b> on the root is cut together with segment <b>N</b> on the tip. On the canvas: click a profile outline to add a split or a pin
          (the matching one is added on the other profile), drag markers to slide them, click a marker for more options.
        </small>
        <small className="hint">{hand ? 'Splits are edited by hand.' : 'Splits are automatic (entity boundaries + sharp corners).'}</small>
        <button
          disabled={!hand}
          onClick={() => {
            patch({ sync: null, contours: { ...job.contours, sync: {} }, plan: null });
            c.setNotice(null);
          }}
        >
          Reset splits &amp; pins to automatic
        </button>
        <NumberField
          label="Corner split angle (°)"
          value={job.cornerSplitDeg}
          min={1}
          onChange={(v) => patch({ cornerSplitDeg: v, sync: null, contours: { ...job.contours, sync: {} }, plan: null })}
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

const loopPlanFor = (result: CutResult, reversed: boolean) => loopPlan(result.topology ?? result.stats.segments, reversed, result.entries);

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
          No wire power is set for “{c.material.name}”. Add it in Place in Machine → Material → Edit…, or set the power by hand before cutting.
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

