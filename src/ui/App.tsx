import { useMemo, useState } from 'react';
import { generateCut } from '../core/cut/pipeline';
import type { Vec2 } from '../core/geom/vec';
import { loadDxfProfile } from '../core/io/loadProfile';
import { defaultJob, machines, materials } from '../core/presets';
import type { JobSettings } from '../core/types';
import exampleRoot from '../../tests/fixtures/vtail-root.dxf?raw';
import exampleTip from '../../tests/fixtures/vtail-tip.dxf?raw';
import { NumberField, SelectField } from './Fields';
import { Preview2D, type Layers } from './Preview2D';

interface SourceFile {
  name: string;
  text: string;
}

function parseWaypoints(text: string): Vec2[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split(/[,\s]+/).filter(Boolean).map(Number))
    .filter((n) => n.length === 2 && n.every(Number.isFinite))
    .map(([x, y]) => ({ x, y }));
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
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
        <span role="button" tabIndex={0} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>
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
  const [leadText, setLeadText] = useState('');
  const [rootFile, setRootFile] = useState<SourceFile | null>(null);
  const [tipFile, setTipFile] = useState<SourceFile | null>(null);
  const [layers, setLayers] = useState<Layers>({ profiles: true, kerf: true, wires: true, carriages: false });

  const patch = (p: Partial<JobSettings>) => setJob((j) => ({ ...j, ...p }));

  const root = useMemo(() => (rootFile ? loadDxfProfile(rootFile.text, machine.units) : null), [rootFile, machine.units]);
  const tip = useMemo(() => (tipFile ? loadDxfProfile(tipFile.text, machine.units) : null), [tipFile, machine.units]);
  const result = useMemo(
    () => (root?.profile && tip?.profile ? generateCut(root.profile, tip.profile, job, machine) : null),
    [root, tip, job, machine],
  );

  const importWarnings = [
    ...(root?.warnings.map((w) => `Root: ${w}`) ?? []),
    ...(tip?.warnings.map((w) => `Tip: ${w}`) ?? []),
    ...(root && !root.profile ? ['Root: could not build a closed outline.'] : []),
    ...(tip && !tip.profile ? ['Tip: could not build a closed outline.'] : []),
  ];

  const loadExample = () => {
    setRootFile({ name: 'Vtail bottom.DXF (example)', text: exampleRoot });
    setTipFile({ name: 'Vtail top.DXF (example)', text: exampleTip });
    // Back-solved from the DevFoam export of this part.
    patch({ span: 12.07, rootFaceFromLeft: (machine.carriageSpacing - 12.07) / 2, rootSide: 'left', kerf: { root: 0.0998, tip: 0.1116 }, offset: { x: 4.7221, y: 0.7001 } });
  };

  const u = machine.units;
  const baseName = (rootFile?.name ?? 'cut').replace(/\.[^.]+$/, '').replace(/\s*\(example\)$/, '');

  return (
    <div className="app">
      <header className="topbar">
        <h1>HuskyFoam</h1>
        <label>
          Machine
          <select
            value={machineId}
            onChange={(e) => {
              setMachineId(e.target.value);
            }}
          >
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
        <button
          className="primary"
          disabled={!result?.ok}
          onClick={() => result && download(`${baseName}.nc`, result.gcode)}
        >
          Export G-code
        </button>
      </header>

      <div className="main">
        <aside className="sidebar">
          <section>
            <h2>Profiles</h2>
            <FileRow label="Root" color="var(--root)" file={rootFile} onLoad={setRootFile} />
            <FileRow label="Tip" color="var(--tip)" file={tipFile} onLoad={setTipFile} />
            <button onClick={loadExample}>Load V-tail example</button>
          </section>

          <section>
            <h2>Block placement ({u})</h2>
            <NumberField label="Block span" value={job.span} min={0} onChange={(v) => patch({ span: v })} hint="Distance from the root face to the tip face" />
            <NumberField label="Root face from left carriage" value={job.rootFaceFromLeft} onChange={(v) => patch({ rootFaceFromLeft: v })} />
            <SelectField label="Root on" value={job.rootSide} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} onChange={(v) => patch({ rootSide: v })} />
            <button
              style={{ marginBottom: 8 }}
              onClick={() => patch({ rootFaceFromLeft: (machine.carriageSpacing - job.span) / 2 })}
            >
              Center block ({machine.carriageSpacing} {u} wire)
            </button>
            <NumberField label="Part offset X" value={job.offset.x} onChange={(v) => patch({ offset: { ...job.offset, x: v } })} />
            <NumberField label="Part offset Y" value={job.offset.y} onChange={(v) => patch({ offset: { ...job.offset, y: v } })} />
          </section>

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
            <NumberField label="Corner split angle (°)" value={job.cornerSplitDeg} min={1} onChange={(v) => patch({ cornerSplitDeg: v })} hint="Corners sharper than this become sync points, in addition to entity boundaries" />
          </section>

          <section>
            <h2>Lead-in waypoints</h2>
            <small style={{ color: 'var(--muted)' }}>
              One "x, y" per line ({u}). The wire goes home → these → loop start, and back the same way. Empty = straight line from home.
            </small>
            <textarea
              value={leadText}
              placeholder={`${machine.home.x}, 3`}
              onChange={(e) => {
                setLeadText(e.target.value);
                patch({ leadIn: parseWaypoints(e.target.value) });
              }}
            />
          </section>
        </aside>

        <div className="workspace">
          <div style={{ position: 'relative', minHeight: 0, display: 'grid' }}>
            <Preview2D root={root?.profile ?? null} tip={tip?.profile ?? null} offset={job.offset} result={result} machine={machine} layers={layers} />
            <div className="layers">
              {(
                [
                  ['profiles', 'Profiles'],
                  ['kerf', 'Kerf path'],
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
                <span>Moves <b>{result.stats.moves}</b></span>
                <span>Cut time <b>{result.stats.cutMinutes.toFixed(1)} min</b></span>
                <span>Max carriage speed <b>{result.stats.maxCarriageSpeed.toFixed(2)} {u}/min</b> (cap {machine.maxSpeed})</span>
                <span>
                  <span className="swatch" style={{ background: 'var(--left)' }} />left
                  <span className="swatch" style={{ background: 'var(--right)', marginLeft: 8 }} />right carriage
                </span>
              </div>
            )}
            {!result && !importWarnings.length && <div className="stats">No cut yet.</div>}
            {result?.errors.map((e, i) => <div key={`e${i}`} className="msg err">{e}</div>)}
            {[...importWarnings, ...(result?.warnings.map((w) => w.message) ?? [])].map((w, i) => (
              <div key={`w${i}`} className="msg warn">{w}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
