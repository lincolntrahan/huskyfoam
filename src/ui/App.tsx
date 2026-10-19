import { useMemo, useState } from 'react';
import { generateCut } from '../core/cut/pipeline';
import type { SyncEdit } from '../core/sync/edit';
import type { Vec2 } from '../core/geom/vec';
import type { Profile } from '../core/geom/profile';
import { loadDxfProfile } from '../core/io/loadProfile';
import type { CutPlan } from '../core/plan/model';
import { leTePlan, loopPlan, type Rect } from '../core/plan/templates';
import { defaultJob, machines, materials } from '../core/presets';
import type { JobSettings } from '../core/types';
import exampleRoot from '../../tests/fixtures/vtail-root.dxf?raw';
import exampleTip from '../../tests/fixtures/vtail-tip.dxf?raw';
import { NumberField, SelectField } from './Fields';
import { PlanPanel } from './PlanPanel';
import { TransformPanel } from './TransformPanel';
import { Preview2D, type Layers, type Sides } from './Preview2D';

interface SourceFile {
  name: string;
  text: string;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Bounding box of both positioned profiles, grown by `margin`. */
/** Bounding box of the given (already positioned) points, grown by `margin`. */
function fitBlock(pts: Vec2[], margin: number): Rect {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const x = r(Math.min(...xs) - margin);
  const y = r(Math.min(...ys) - margin);
  return { x, y, w: r(Math.max(...xs) + margin - x), h: r(Math.max(...ys) + margin - y) };
}

function FileRow(props: { label: string; color: string; file: SourceFile | null; onLoad: (f: SourceFile) => void }) {
  return (
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
  );
}

export function App() {
  const [machineId, setMachineId] = useState(machines[0].id);
  const [materialId, setMaterialId] = useState(materials[0].id);
  const machine = machines.find((m) => m.id === machineId)!;
  const material = materials.find((m) => m.id === materialId)!;

  const [job, setJob] = useState<JobSettings>(() => defaultJob(machine, material));
  const [rootFile, setRootFile] = useState<SourceFile | null>(null);
  const [tipFile, setTipFile] = useState<SourceFile | null>(null);
  const [layers, setLayers] = useState<Layers>({ profiles: true, kerf: true, plan: true, wires: true, carriages: false });
  const [sides, setSides] = useState<Sides>('both');
  const [clearance, setClearance] = useState(0.5);
  const [outBack, setOutBack] = useState(1);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);

  const patch = (p: Partial<JobSettings>) => setJob((j) => ({ ...j, ...p }));

  const root = useMemo(() => (rootFile ? loadDxfProfile(rootFile.text, machine.units) : null), [rootFile, machine.units]);
  const tip = useMemo(() => (tipFile ? loadDxfProfile(tipFile.text, machine.units) : null), [tipFile, machine.units]);
  const [notice, setNotice] = useState<string | null>(null);
  const result = useMemo(
    () => (root?.profile && tip?.profile ? generateCut(root.profile, tip.profile, job, machine) : null),
    [root, tip, job, machine],
  );
  const plan: CutPlan | null = result?.plan ?? null;
  const setPlan = (p: CutPlan) => patch({ plan: p });

  const importWarnings = [
    ...(root?.warnings.map((w) => `Root: ${w}`) ?? []),
    ...(tip?.warnings.map((w) => `Tip: ${w}`) ?? []),
    ...(root && !root.profile ? ['Root: could not build a closed outline.'] : []),
    ...(tip && !tip.profile ? ['Tip: could not build a closed outline.'] : []),
  ];

  const profiles = [root?.profile, tip?.profile].filter((p): p is Profile => !!p);
  // the outlines as cut (transformed); before the first result, the raw outlines at the part offset
  const cutPts = (): Vec2[] =>
    result?.profilePts.root.length
      ? [...result.profilePts.root, ...result.profilePts.tip]
      : profiles.flatMap((p) => p.pts).map((p) => ({ x: p.x + job.offset.x, y: p.y + job.offset.y }));
  const blockOrFit = (): Rect => (job.block.w > 0 && job.block.h > 0 ? job.block : fitBlock(cutPts(), 0.1));

  // Sync edits arrive in cut space (what's on screen); store them in the job's raw form.
  const onSyncChange = (e: SyncEdit) => {
    if (!result?.syncToJob) return;
    patch({ sync: result.syncToJob(e.sync), plan: e.plan });
    setNotice(e.note ?? null);
  };
  const onChordPick = (side: 'root' | 'tip', end: 'le' | 'te', k: number) => {
    if (!result?.sync || !result.rawS) return;
    const s = result.rawS(side, result.sync[side][k]);
    patch({ transforms: { ...job.transforms, [side]: { ...job.transforms[side], [end]: s } } });
  };

  const loadExample = () => {
    const rootLoaded = loadDxfProfile(exampleRoot, machine.units).profile!;
    const tipLoaded = loadDxfProfile(exampleTip, machine.units).profile!;
    const offset = { x: 4.7221, y: 0.7001 };
    setRootFile({ name: 'Vtail bottom.DXF (example)', text: exampleRoot });
    setTipFile({ name: 'Vtail top.DXF (example)', text: exampleTip });
    setSelectedStep(null);
    // Back-solved from the DevFoam export of this part.
    patch({
      span: 12.07,
      rootFaceFromLeft: (machine.carriageSpacing - 12.07) / 2,
      rootSide: 'left',
      kerf: { root: 0.0998, tip: 0.1116 },
      offset,
      block: fitBlock([...rootLoaded.pts, ...tipLoaded.pts].map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })), 0.1),
      sync: null,
      plan: null,
    });
  };

  const applyLeTe = () => {
    if (!result || !root?.profile) return;
    const block = blockOrFit();
    const splits = result.splitPts.root;
    setSelectedStep(null);
    patch({ block, plan: leTePlan({ splits, block, clearance }) });
  };

  const u = machine.units;
  const baseName = (rootFile?.name ?? 'cut').replace(/\.[^.]+$/, '').replace(/\s*\(example\)$/, '');

  return (
    <div className="app">
      <header className="topbar">
        <h1>HuskyFoam</h1>
        <label>
          Machine
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label>
          Material
          <select
            value={materialId}
            onChange={(e) => {
              const mat = materials.find((m) => m.id === e.target.value)!;
              setMaterialId(mat.id);
              patch({ cutSpeed: mat.cutSpeed, kerf: { root: mat.kerfRoot, tip: mat.kerfTip } });
            }}
          >
            {materials.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <button className="primary" disabled={!result?.ok} onClick={() => result && download(`${baseName}.nc`, result.gcode)}>
          Export G-code
        </button>
      </header>

      <div className="main">
        <aside className="sidebar">
          <section>
            <h2>Profiles</h2>
            <FileRow label="Root" color="var(--root)" file={rootFile} onLoad={(f) => { setRootFile(f); patch({ plan: null, sync: null }); }} />
            <FileRow label="Tip" color="var(--tip)" file={tipFile} onLoad={(f) => { setTipFile(f); patch({ plan: null, sync: null }); }} />
            <button onClick={loadExample}>Load V-tail example</button>
          </section>

          <section>
            <h2>Block placement ({u})</h2>
            <NumberField label="Block span" value={job.span} min={0} onChange={(v) => patch({ span: v })} hint="Distance from the root face to the tip face" />
            <NumberField label="Root face from left carriage" value={job.rootFaceFromLeft} onChange={(v) => patch({ rootFaceFromLeft: v })} />
            <SelectField label="Root on" value={job.rootSide} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} onChange={(v) => patch({ rootSide: v })} />
            <button
              style={{ marginBottom: 8, marginRight: 6 }}
              title="Cut the opposite-hand panel from the same files: puts the root on the other carriage"
              onClick={() => patch({ rootSide: job.rootSide === 'left' ? 'right' : 'left' })}
            >
              Mirror L/R
            </button>
            <button style={{ marginBottom: 8 }} onClick={() => patch({ rootFaceFromLeft: (machine.carriageSpacing - job.span) / 2 })}>
              Center block ({machine.carriageSpacing} {u} wire)
            </button>
            <NumberField label="Part offset X" value={job.offset.x} onChange={(v) => patch({ offset: { ...job.offset, x: v } })} />
            <NumberField label="Part offset Y" value={job.offset.y} onChange={(v) => patch({ offset: { ...job.offset, y: v } })} />
          </section>

          <section>
            <h2>Foam block outline ({u})</h2>
            <NumberField label="Left edge X" value={job.block.x} onChange={(v) => patch({ block: { ...job.block, x: v } })} />
            <NumberField label="Bottom Y" value={job.block.y} onChange={(v) => patch({ block: { ...job.block, y: v } })} />
            <NumberField label="Width" value={job.block.w} min={0} onChange={(v) => patch({ block: { ...job.block, w: v } })} />
            <NumberField label="Height" value={job.block.h} min={0} onChange={(v) => patch({ block: { ...job.block, h: v } })} hint="0 = no block; jog checks are off" />
            <button disabled={!profiles.length} onClick={() => patch({ block: fitBlock(cutPts(), 0.1) })}>
              Fit block to part
            </button>
          </section>

          {plan && result && (
            <PlanPanel plan={plan} result={result} onChange={setPlan} onLoop={(reversed) => patch({ plan: loopPlan(result.stats.segments, reversed) })} onLeTe={applyLeTe} selected={selectedStep} onSelect={setSelectedStep} />
          )}
          <section>
            <NumberField label={`Template clearance (${u})`} value={clearance} min={0} onChange={setClearance} hint="How far outside the block the LE→TE template puts run-in/out and jog points" />
            <NumberField label={`Out-and-back distance (${u})`} value={outBack} min={0} onChange={setOutBack} hint="How far past the split an out-and-back runs out" />
            <small className="hint">
              Jogs run at {machine.jogSpeed} {u}/min (machine preset).
            </small>
          </section>

          <TransformPanel
            value={job.transforms}
            units={u}
            onChange={(t, opts) => patch({ transforms: t, ...(opts?.resetPlan ? { plan: null } : {}) })}
          />

          <section>
            <h2>Kerf & speed</h2>
            <NumberField label={`Root kerf (${u})`} value={job.kerf.root} min={0} step={0.001} onChange={(v) => patch({ kerf: { ...job.kerf, root: v } })} hint="Full kerf width at the root face; the path is offset by half" />
            <NumberField label={`Tip kerf (${u})`} value={job.kerf.tip} min={0} step={0.001} onChange={(v) => patch({ kerf: { ...job.kerf, tip: v } })} />
            <NumberField label={`Cut speed (${u}/min)`} value={job.cutSpeed} min={0} onChange={(v) => patch({ cutSpeed: v })} hint="Wire speed at the faster foam face" />
          </section>

          <section>
            <h2>Sampling</h2>
            <SelectField
              label="Point spacing"
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
            <NumberField label="Corner split angle (°)" value={job.cornerSplitDeg} min={1} onChange={(v) => patch({ cornerSplitDeg: v, sync: null, plan: null })} hint="Corners sharper than this become automatic splits, in addition to entity boundaries. Changing it resets splits, pins and the plan." />
          </section>

          <section>
            <h2>Sync points</h2>
            <small className="hint">
              Click a profile outline to add a split or a pin (the matching one is added on the other profile). Drag markers to slide them; click one
              for more options. {job.sync ? 'Splits are edited by hand.' : 'Splits are automatic.'}
            </small>
            <button disabled={!job.sync} onClick={() => { patch({ sync: null, plan: null }); setNotice(null); }}>
              Reset splits &amp; pins to automatic
            </button>
          </section>
        </aside>

        <div className="workspace">
          <div style={{ position: 'relative', minHeight: 0, display: 'grid' }}>
            <Preview2D
              root={root?.profile ?? null}
              tip={tip?.profile ?? null}
              offset={job.offset}
              result={result}
              machine={machine}
              layers={layers}
              block={job.block}
              plan={plan}
              onPlanChange={setPlan}
              outBackDistance={outBack}
              onSyncChange={onSyncChange}
              onChordPick={onChordPick}
              selectedStep={selectedStep}
              onSelectStep={setSelectedStep}
              sides={sides}
              rootSide={job.rootSide}
            />
            <div className="layers">
              <div className="segmented" role="group" aria-label="Which face to show">
                {(
                  [
                    ['root', `Root (${job.rootSide === 'left' ? 'left' : 'right'})`],
                    ['tip', `Tip (${job.rootSide === 'left' ? 'right' : 'left'})`],
                    ['both', 'Both'],
                  ] as [Sides, string][]
                ).map(([k, label]) => (
                  <button key={k} className={sides === k ? 'active' : ''} aria-pressed={sides === k} onClick={() => setSides(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {(
                [
                  ['profiles', 'Profiles'],
                  ['kerf', 'Kerf loop'],
                  ['plan', 'Cut plan'],
                  ['wires', 'Wire lines'],
                  ['carriages', 'Carriage paths'],
                ] as [keyof Layers, string][]
              ).map(([k, label]) => (
                <label key={k}>
                  <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="status">
            {result && (
              <div className="stats">
                <span>Segments <b>{result.stats.segments}</b></span>
                <span>Steps <b>{plan?.steps.length ?? 0}</b></span>
                <span>Moves <b>{result.stats.moves}</b></span>
                <span>Time <b>{result.stats.cutMinutes.toFixed(1)} min</b></span>
                <span>Max carriage speed <b>{result.stats.maxCarriageSpeed.toFixed(2)} {u}/min</b> (cap {machine.maxSpeed})</span>
                <span>
                  <span className="swatch" style={{ background: 'var(--cut)' }} />cut
                  <span className="swatch" style={{ background: 'var(--jog)', marginLeft: 8 }} />jog
                  <span className="swatch" style={{ background: 'var(--left)', marginLeft: 8 }} />left
                  <span className="swatch" style={{ background: 'var(--right)', marginLeft: 8 }} />right carriage
                </span>
              </div>
            )}
            {!result && !importWarnings.length && <div className="stats">No cut yet.</div>}
            {result?.errors.map((e, i) => <div key={`e${i}`} className="msg err">{e}</div>)}
            {notice && (
              <div className="msg info">
                {notice} <button onClick={() => setNotice(null)}>OK</button>
              </div>
            )}
            {[...importWarnings, ...(result?.warnings.map((w) => w.message) ?? [])].map((w, i) => (
              <div key={`w${i}`} className="msg warn">{w}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
