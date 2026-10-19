import { useEffect, useMemo, useRef, useState } from 'react';
import { generateCut } from '../core/cut/pipeline';
import type { Profile } from '../core/geom/profile';
import type { Vec2 } from '../core/geom/vec';
import { loadDxfProfile } from '../core/io/loadProfile';
import { makeProject, parseProject, type SourceFile } from '../core/io/project';
import type { CutPlan } from '../core/plan/model';
import { remapSegmentMap } from '../core/plan/remap';
import { leTePlan, type Rect } from '../core/plan/templates';
import { defaultJob } from '../core/presets';
import type { SyncEdit } from '../core/sync/edit';
import type { JobSettings, MaterialPreset } from '../core/types';
import exampleRoot from '../../tests/fixtures/vtail-root.dxf?raw';
import exampleTip from '../../tests/fixtures/vtail-tip.dxf?raw';
import { ExportPage, ImportPage, PreviewPage, SegmentPage, SequencePage, SetupPage, TransformPage, type PageCtx } from './pages';
import { download, MachineEditor, MaterialEditor } from './PresetEditor';
import { Preview2D, type Layers, type Sides } from './Preview2D';
import { Stepper } from './Stepper';
import { STEPS, stagesUpTo, stepStates, type StepId } from './steps';
import { usePresets } from './usePresets';

const AUTOSAVE = 'huskyfoam:autosave';

/** Bounding box of the given (already positioned) points, grown by `margin`. */
function fitBlock(pts: Vec2[], margin: number): Rect {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const x = r(Math.min(...xs) - margin);
  const y = r(Math.min(...ys) - margin);
  return { x, y, w: r(Math.max(...xs) + margin - x), h: r(Math.max(...ys) + margin - y) };
}

export function App() {
  const presets = usePresets();
  const [machineId, setMachineId] = useState(presets.machines[0].id);
  const [materialId, setMaterialId] = useState(presets.materials[0].id);
  const machine = presets.machines.find((m) => m.id === machineId) ?? presets.machines[0];
  const material = presets.materials.find((m) => m.id === materialId) ?? presets.materials[0];
  const [editor, setEditor] = useState<'machine' | 'material' | null>(null);

  const [job, setJob] = useState<JobSettings>(() => defaultJob(machine, material));
  const [rootFile, setRootFile] = useState<SourceFile | null>(null);
  const [tipFile, setTipFile] = useState<SourceFile | null>(null);
  const [page, setPage] = useState<StepId>('import');
  const [layers, setLayers] = useState<Layers>(STEPS[0].layers);
  const [sides, setSides] = useState<Sides>('both');
  const [clearance, setClearance] = useState(0.5);
  const [outBack, setOutBack] = useState(1);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const patch = (p: Partial<JobSettings>) => setJob((j) => ({ ...j, ...p }));
  const applyMaterial = (mat: MaterialPreset) => {
    setMaterialId(mat.id);
    setJob((j) => ({
      ...j,
      cutSpeed: mat.cutSpeed,
      kerf: { ...j.kerf, root: mat.kerfRoot, tip: mat.kerfTip },
      kerfTable: mat.kerfTable ?? [],
      dwell: mat.cornerDwell ?? j.dwell,
      wireWatts: mat.wireWatts ?? null,
    }));
  };

  const root = useMemo(() => (rootFile ? loadDxfProfile(rootFile.text, machine.units) : null), [rootFile, machine.units]);
  const tip = useMemo(() => (tipFile ? loadDxfProfile(tipFile.text, machine.units) : null), [tipFile, machine.units]);
  const result = useMemo(
    () => (root?.profile && tip?.profile ? generateCut(root.profile, tip.profile, job, machine) : null),
    [root, tip, job, machine],
  );
  const plan: CutPlan | null = result?.plan ?? null;

  // ---- pages
  const importWarnings = [
    ...(root?.warnings.map((w) => `Root: ${w}`) ?? []),
    ...(tip?.warnings.map((w) => `Tip: ${w}`) ?? []),
    ...(root && !root.profile ? ['Root: could not build a closed outline.'] : []),
    ...(tip && !tip.profile ? ['Tip: could not build a closed outline.'] : []),
  ];
  const states = stepStates({ haveProfiles: !!(root?.profile && tip?.profile), importWarnings: importWarnings.length, result });
  const goTo = (id: StepId) => {
    if (states[id].status === 'locked') return;
    setPage(id);
    setLayers(STEPS.find((s) => s.id === id)!.layers);
    setSelectedStep(null);
  };
  // if what you're looking at becomes locked (e.g. a profile was replaced), fall back to the last open page
  useEffect(() => {
    if (states[page].status !== 'locked') return;
    const open = STEPS.filter((s) => states[s.id].status !== 'locked');
    goTo(open[open.length - 1].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states[page].status]);
  const idx = STEPS.findIndex((s) => s.id === page);
  const prev = STEPS[idx - 1];
  const next = STEPS[idx + 1];

  // ---- autosave the current job in this browser; restore it once on start-up
  const restored = useRef(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTOSAVE);
      if (saved) openProject(saved, 'Restored your last session from this browser.');
    } catch {
      /* nothing usable saved */
    }
    restored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      try {
        if (rootFile || tipFile) localStorage.setItem(AUTOSAVE, JSON.stringify(makeProject(rootFile, tipFile, job, machine, material)));
      } catch {
        /* storage full or blocked: autosave is best-effort */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [rootFile, tipFile, job, machine, material]);

  function openProject(text: string, message: string) {
    const p = parseProject(text);
    setMachineId(presets.adopt('machine', p.machine));
    setMaterialId(presets.adopt('material', p.material));
    setRootFile(p.root);
    setTipFile(p.tip);
    setJob(p.job); // already normalized for older projects
    setSelectedStep(null);
    setNotice(message);
  }
  const startFresh = () => {
    try {
      localStorage.removeItem(AUTOSAVE);
    } catch {
      /* ignore */
    }
    setRootFile(null);
    setTipFile(null);
    setJob(defaultJob(machine, material));
    setNotice(null);
    goTo('import');
  };

  // ---- geometry helpers
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
    const segmentOverrides = e.change ? remapSegmentMap(job.segmentOverrides, e.change) : job.segmentOverrides;
    patch({ sync: result.syncToJob(e.sync), plan: e.plan, segmentOverrides });
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
      kerf: { mode: 'fixed', root: 0.0998, tip: 0.1116 },
      offset,
      block: fitBlock([...rootLoaded.pts, ...tipLoaded.pts].map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })), 0.1),
      sync: null,
      plan: null,
    });
  };

  const applyLeTe = () => {
    if (!result || !root?.profile) return;
    const block = blockOrFit();
    setSelectedStep(null);
    patch({ block, plan: leTePlan({ splits: result.splitPts.root, block, clearance }) });
  };

  const baseName = (rootFile?.name ?? 'cut').replace(/\.[^.]+$/, '').replace(/\s*\(example\)$/, '');

  const ctx: PageCtx = {
    job,
    patch,
    result,
    plan,
    machine,
    material,
    machines: presets.machines,
    materials: presets.materials,
    origin: presets.origin,
    setMachineId,
    applyMaterial,
    openEditor: setEditor,
    rootFile,
    tipFile,
    root,
    tip,
    loadRoot: (f) => {
      setRootFile(f);
      patch({ plan: null, sync: null });
    },
    loadTip: (f) => {
      setTipFile(f);
      patch({ plan: null, sync: null });
    },
    loadExample,
    fitBlock: () => fitBlock(cutPts(), 0.1),
    clearance,
    setClearance,
    outBack,
    setOutBack,
    selectedStep,
    setSelectedStep,
    applyLeTe,
    baseName,
    setNotice,
  };

  // ---- problems: this page's and every earlier page's (Export shows all)
  const shown = stagesUpTo(page);
  const errors = (result?.errors ?? []).filter((_, i) => shown.has(result!.errorStages[i]));
  const warnings = [...importWarnings, ...(result?.warnings.filter((w) => shown.has(w.stage)).map((w) => w.message) ?? [])];

  return (
    <div className="app">
      <header className="topbar">
        <h1>HuskyFoam</h1>
        <span className="muted-text">
          {machine.name} · {material.name}
        </span>
        <div className="spacer" />
        <button
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,.hfoam.json';
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              try {
                openProject(await file.text(), `Opened ${file.name}.`);
              } catch (err) {
                setNotice((err as Error).message);
              }
            };
            input.click();
          }}
        >
          Open project…
        </button>
        <button
          disabled={!rootFile && !tipFile}
          onClick={() => download(`${baseName}.hfoam.json`, JSON.stringify(makeProject(rootFile, tipFile, job, machine, material), null, 1), 'application/json')}
        >
          Save project
        </button>
      </header>

      <Stepper current={page} states={states} onGo={goTo} />

      <div className="main">
        <aside className="sidebar">
          <div className="page-title">
            <span className="step-n">{idx + 1}</span> {STEPS[idx].label}
          </div>
          <div className="page-body">
            {page === 'import' && <ImportPage {...ctx} />}
            {page === 'setup' && <SetupPage {...ctx} />}
            {page === 'transform' && <TransformPage {...ctx} />}
            {page === 'segment' && <SegmentPage {...ctx} />}
            {page === 'sequence' && <SequencePage {...ctx} />}
            {page === 'preview' && <PreviewPage {...ctx} />}
            {page === 'export' && <ExportPage {...ctx} fileName={fileName ?? baseName} setFileName={setFileName} />}
          </div>
          <div className="page-nav">
            <button disabled={!prev} onClick={() => prev && goTo(prev.id)}>
              ← Back
            </button>
            {next && (
              <button className="primary" disabled={states[next.id].status === 'locked'} title={states[next.id].reason} onClick={() => goTo(next.id)}>
                Next: {next.label} →
              </button>
            )}
          </div>
        </aside>

        <div className="workspace">
          <div style={{ position: 'relative', minHeight: 0, display: 'grid' }}>
            <Preview2D
              mode={page}
              root={root?.profile ?? null}
              tip={tip?.profile ?? null}
              offset={job.offset}
              result={result}
              machine={machine}
              layers={layers}
              block={job.block}
              plan={plan}
              onPlanChange={(p) => patch({ plan: p })}
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
            {result && page !== 'import' && (
              <div className="stats">
                <span>
                  Segments <b>{result.stats.segments}</b>
                </span>
                <span>
                  Time <b>{result.stats.cutMinutes.toFixed(1)} min</b>
                </span>
                <span>
                  Max carriage speed{' '}
                  <b>
                    {result.stats.maxCarriageSpeed.toFixed(2)} {machine.units}/min
                  </b>{' '}
                  (cap {machine.maxSpeed})
                </span>
                <span>
                  <span className="swatch" style={{ background: 'var(--cut)' }} />
                  cut
                  <span className="swatch" style={{ background: 'var(--jog)', marginLeft: 8 }} />
                  jog
                  <span className="swatch" style={{ background: 'var(--left)', marginLeft: 8 }} />
                  left
                  <span className="swatch" style={{ background: 'var(--right)', marginLeft: 8 }} />
                  right carriage
                </span>
              </div>
            )}
            {errors.map((e, i) => (
              <div key={`e${i}`} className="msg err">
                {e}
              </div>
            ))}
            {notice && (
              <div className="msg info">
                <span>{notice}</span>
                <span>
                  {notice.startsWith('Restored') && <button onClick={startFresh}>Start fresh</button>} <button onClick={() => setNotice(null)}>OK</button>
                </span>
              </div>
            )}
            {warnings.map((w, i) => (
              <div key={`w${i}`} className="msg warn">
                {w}
              </div>
            ))}
            {!errors.length && !warnings.length && !notice && !result && <div className="stats">Load a root and a tip DXF to start.</div>}
          </div>
        </div>
      </div>

      {editor === 'machine' && (
        <MachineEditor
          initial={machine}
          origin={presets.origin('machine', machine.id)}
          onSave={(m, asCopy) => {
            setMachineId(presets.save('machine', m, asCopy));
            setEditor(null);
          }}
          onDelete={() => {
            presets.remove('machine', machine.id);
            setMachineId(presets.machines[0].id);
            setEditor(null);
          }}
          onClose={() => setEditor(null)}
        />
      )}
      {editor === 'material' && (
        <MaterialEditor
          initial={material}
          origin={presets.origin('material', material.id)}
          machine={machine}
          onSave={(m, asCopy) => {
            const id = presets.save('material', m, asCopy);
            applyMaterial({ ...m, id });
            setEditor(null);
          }}
          onDelete={() => {
            presets.remove('material', material.id);
            applyMaterial(presets.materials[0]);
            setEditor(null);
          }}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
