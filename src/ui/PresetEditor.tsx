import { useState } from 'react';
import { defaultKerfTest, kerfTableFromMeasurements, kerfTestGcode, type KerfTestSpec } from '../core/cut/kerfTest';
import { validateMachine, validateMaterial } from '../core/io/project';
import type { AxisLetters, KerfPoint, MachinePreset, MaterialPreset } from '../core/types';
import { NumberField, SelectField } from './Fields';
import { slug, type PresetOrigin } from './usePresets';

export function download(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function pickJson(): Promise<unknown | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try {
        resolve(JSON.parse(await f.text()));
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
}

interface ShellProps<T> {
  title: string;
  value: T;
  origin: PresetOrigin;
  errors: string[];
  folder: 'machines' | 'materials';
  onSave: (v: T, asCopy: boolean) => void;
  onDelete: () => void;
  onImport: (v: T) => void;
  onClose: () => void;
  children: React.ReactNode;
}

function Shell<T extends { id: string; name: string }>(p: ShellProps<T>) {
  const note =
    p.origin === 'repo'
      ? 'Team preset (from the repo): saving makes a copy in this browser. To change it for everyone, use “Export for repo” and open a PR.'
      : p.origin === 'project'
        ? 'Snapshot from an opened project: saving makes a copy in this browser.'
        : 'Saved in this browser only. Use “Export for repo” to share it with the team.';
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal" role="dialog" aria-label={p.title}>
        <header>
          <h2>{p.title}</h2>
          <button className="muted" onClick={p.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <small className="hint">{note}</small>
        <div className="modal-body">{p.children}</div>
        {p.errors.map((e) => (
          <div key={e} className="msg err">
            {e}
          </div>
        ))}
        <footer>
          <button
            onClick={async () => {
              const v = await pickJson();
              if (v && typeof v === 'object') p.onImport({ ...(p.value as object), ...(v as object) } as T);
            }}
          >
            Import JSON…
          </button>
          <button
            title={`Download as presets/${p.folder}/${slug(p.value.name)}.json`}
            onClick={() => {
              const { id: _id, ...rest } = p.value;
              download(`${slug(p.value.name)}.json`, JSON.stringify({ id: slug(p.value.name), ...rest }, null, 2) + '\n', 'application/json');
            }}
          >
            Export for repo
          </button>
          <span className="spacer" />
          {p.origin === 'local' && (
            <button className="danger" onClick={p.onDelete}>
              Delete
            </button>
          )}
          {p.origin === 'local' && (
            <button disabled={p.errors.length > 0} onClick={() => p.onSave(p.value, true)}>
              Save as copy
            </button>
          )}
          <button className="primary" disabled={p.errors.length > 0} onClick={() => p.onSave(p.value, false)}>
            {p.origin === 'local' ? 'Save' : 'Save to this browser'}
          </button>
        </footer>
      </div>
    </div>
  );
}

const AXIS_NAMES: Record<keyof AxisLetters, string> = { leftH: 'Left horizontal', leftV: 'Left vertical', rightH: 'Right horizontal', rightV: 'Right vertical' };

export function MachineEditor(props: {
  initial: MachinePreset;
  origin: PresetOrigin;
  onSave: (m: MachinePreset, asCopy: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [m, setM] = useState<MachinePreset>(props.initial);
  const set = (patch: Partial<MachinePreset>) => setM((x) => ({ ...x, ...patch }));
  const u = m.units;
  return (
    <Shell title="Machine" value={m} origin={props.origin} errors={validateMachine(m)} folder="machines" onSave={props.onSave} onDelete={props.onDelete} onImport={setM} onClose={props.onClose}>
      <label className="field">
        <span>Name</span>
        <input value={m.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <SelectField label="Units" value={m.units} options={[{ value: 'in', label: 'Inches' }, { value: 'mm', label: 'Millimetres' }]} onChange={(v) => set({ units: v })} />
      <NumberField label={`Carriage spacing (${u})`} value={m.carriageSpacing} onChange={(v) => set({ carriageSpacing: v })} hint="Distance between the left and right carriage planes, along the wire" />
      <h3>Travel ({u})</h3>
      <NumberField label="X min" value={m.travel.x[0]} onChange={(v) => set({ travel: { ...m.travel, x: [v, m.travel.x[1]] } })} />
      <NumberField label="X max" value={m.travel.x[1]} onChange={(v) => set({ travel: { ...m.travel, x: [m.travel.x[0], v] } })} />
      <NumberField label="Y min" value={m.travel.y[0]} onChange={(v) => set({ travel: { ...m.travel, y: [v, m.travel.y[1]] } })} />
      <NumberField label="Y max" value={m.travel.y[1]} onChange={(v) => set({ travel: { ...m.travel, y: [m.travel.y[0], v] } })} />
      <NumberField label="Home X" value={m.home.x} onChange={(v) => set({ home: { ...m.home, x: v } })} />
      <NumberField label="Home Y" value={m.home.y} onChange={(v) => set({ home: { ...m.home, y: v } })} />
      <h3>Speeds ({u}/min)</h3>
      <NumberField label="Max carriage speed" value={m.maxSpeed} onChange={(v) => set({ maxSpeed: v })} hint="Moves faster than this warn and are slowed down in the G-code" />
      <NumberField label="Jog speed" value={m.jogSpeed} onChange={(v) => set({ jogSpeed: v })} />
      <h3>G-code</h3>
      {(Object.keys(AXIS_NAMES) as (keyof AxisLetters)[]).map((k) => (
        <label key={k} className="field">
          <span>{AXIS_NAMES[k]} axis letter</span>
          <input value={m.axes[k]} maxLength={1} onChange={(e) => set({ axes: { ...m.axes, [k]: e.target.value.toUpperCase() } })} />
        </label>
      ))}
      {m.axisOrder.map((k, i) => (
        <SelectField
          key={i}
          label={`Word ${i + 1} on each line`}
          value={k}
          options={(Object.keys(AXIS_NAMES) as (keyof AxisLetters)[]).map((a) => ({ value: a, label: `${m.axes[a]} (${AXIS_NAMES[a]})` }))}
          onChange={(v) => set({ axisOrder: m.axisOrder.map((x, j) => (j === i ? v : x)) })}
        />
      ))}
      <SelectField label="Feed mode" value={m.feedMode} options={[{ value: 'G93', label: 'G93 inverse time' }, { value: 'G94', label: 'G94 units/min' }]} onChange={(v) => set({ feedMode: v })} />
      <NumberField label="Decimals" value={m.decimals} min={0} step={1} onChange={(v) => set({ decimals: Math.round(v) })} />
      <SelectField
        label="G4 P (dwell) is in"
        value={m.dwellUnits ?? 's'}
        options={[{ value: 's', label: 'Seconds (Mach3 default)' }, { value: 'ms', label: 'Milliseconds' }]}
        onChange={(v) => set({ dwellUnits: v })}
      />
      <label className="field-block">
        <span>Header</span>
        <textarea rows={5} value={m.header} onChange={(e) => set({ header: e.target.value })} />
        <small className="hint">Tokens: {'{units}'} → G20/G21, {'{cutSpeed}'}, {'{wireWatts}'} (material wire power, e.g. “M3 S{'{wireWatts}'}” if your controller sets heat that way).</small>
      </label>
      <label className="field-block">
        <span>Footer</span>
        <textarea rows={2} value={m.footer} onChange={(e) => set({ footer: e.target.value })} />
      </label>
    </Shell>
  );
}

function KerfTableEditor({ rows, units, onChange }: { rows: KerfPoint[]; units: string; onChange: (r: KerfPoint[]) => void }) {
  const set = (i: number, patch: Partial<KerfPoint>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      <div className="kt-row kt-head">
        <span>Face speed ({units}/min)</span>
        <span>Kerf ({units})</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div className="kt-row" key={i}>
          <input type="number" step="any" value={r.speed} onChange={(e) => set(i, { speed: parseFloat(e.target.value) })} aria-label={`row ${i + 1} speed`} />
          <input type="number" step="any" value={r.kerf} onChange={(e) => set(i, { kerf: parseFloat(e.target.value) })} aria-label={`row ${i + 1} kerf`} />
          <button onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`}>
            ✕
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, { speed: rows.at(-1)?.speed ?? 1, kerf: rows.at(-1)?.kerf ?? 0.1 }])}>+ Row</button>
    </div>
  );
}

function KerfTest({ material, machine, onTable }: { material: MaterialPreset; machine: MachinePreset; onTable: (rows: KerfPoint[]) => void }) {
  const u = material.units;
  const [spec, setSpec] = useState<KerfTestSpec>(() => defaultKerfTest(u));
  const [measured, setMeasured] = useState<(number | null)[]>([]);
  const { gcode, plugs } = kerfTestGcode(spec, machine, material);
  const setS = (patch: Partial<KerfTestSpec>) => setSpec((s) => ({ ...s, ...patch }));
  return (
    <div className="kerf-test">
      <small className="hint">
        Cuts one square plug per speed with a straight wire and no kerf offset, using machine “{machine.name}”. Measure each plug; kerf = nominal − measured.
      </small>
      <NumberField label={`Plug size (${u})`} value={spec.nominal} onChange={(v) => setS({ nominal: v })} />
      <NumberField label={`Block left X (${u})`} value={spec.blockX} onChange={(v) => setS({ blockX: v })} />
      <NumberField label={`Block bottom Y (${u})`} value={spec.blockY} onChange={(v) => setS({ blockY: v })} />
      <NumberField label={`Gap (${u})`} value={spec.gap} onChange={(v) => setS({ gap: v })} hint="Between plugs, and how far below the block the wire travels" />
      <NumberField label={`Lift (${u})`} value={spec.lift} onChange={(v) => setS({ lift: v })} hint="How far above the block's bottom the plugs start" />
      <small className="hint">
        Needs a block at least {(spec.gap + plugs.length * (spec.nominal + spec.gap)).toFixed(2)} × {(spec.lift + spec.nominal + spec.gap).toFixed(2)} {u}.
      </small>
      <button onClick={() => download(`kerf-test-${slug(material.name)}.nc`, gcode)}>Download test G-code</button>
      <div className="kt-row kt-head">
        <span>Plug (speed)</span>
        <span>Measured ({u})</span>
        <span>Kerf</span>
      </div>
      {plugs.map((p, i) => {
        const m = measured[i];
        return (
          <div className="kt-row" key={p.n}>
            <span>
              {p.n} ({p.speed.toFixed(2)})
            </span>
            <input
              type="number"
              step="any"
              aria-label={`plug ${p.n} measured`}
              value={m ?? ''}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setMeasured((arr) => plugs.map((_, j) => (j === i ? (Number.isFinite(v) ? v : null) : (arr[j] ?? null))));
              }}
            />
            <span>{m ? (spec.nominal - m).toFixed(4) : '–'}</span>
          </div>
        );
      })}
      <button disabled={!measured.some((m) => m)} onClick={() => onTable(kerfTableFromMeasurements(plugs, spec.nominal, measured))}>
        Use these as the kerf table
      </button>
    </div>
  );
}

export function MaterialEditor(props: {
  initial: MaterialPreset;
  origin: PresetOrigin;
  machine: MachinePreset;
  onSave: (m: MaterialPreset, asCopy: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [m, setM] = useState<MaterialPreset>(props.initial);
  const set = (patch: Partial<MaterialPreset>) => setM((x) => ({ ...x, ...patch }));
  const u = m.units;
  const dwell = m.cornerDwell ?? { enabled: false, angleDeg: 30, seconds: 0.5 };
  return (
    <Shell title="Material" value={m} origin={props.origin} errors={validateMaterial(m)} folder="materials" onSave={props.onSave} onDelete={props.onDelete} onImport={setM} onClose={props.onClose}>
      <label className="field">
        <span>Name</span>
        <input value={m.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <SelectField label="Units" value={m.units} options={[{ value: 'in', label: 'Inches' }, { value: 'mm', label: 'Millimetres' }]} onChange={(v) => set({ units: v })} />
      <NumberField label={`Cut speed (${u}/min)`} value={m.cutSpeed} onChange={(v) => set({ cutSpeed: v })} hint="Wire speed at the faster foam face" />
      <label className="field" title="Set your hot-wire supply to this. Written into the G-code as a comment and the {wireWatts} header token.">
        <span>Wire power (W)</span>
        <input
          type="number"
          step="any"
          min={0}
          placeholder="not set"
          value={m.wireWatts ?? ''}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            set({ wireWatts: Number.isFinite(v) ? v : undefined });
          }}
        />
      </label>
      <h3>Kerf ({u})</h3>
      <SelectField
        label="Kerf"
        value={m.kerfMode ?? 'fixed'}
        options={[
          { value: 'fixed', label: 'Fixed root / tip' },
          { value: 'auto', label: 'Auto from speed table' },
        ]}
        onChange={(v) => set({ kerfMode: v })}
      />
      {m.kerfMode === 'auto' && !m.kerfTable?.length && <small className="hint">Fill the table below (or run the kerf test); until then the fixed values are used.</small>}
      <NumberField label="Root kerf (fixed mode)" value={m.kerfRoot} onChange={(v) => set({ kerfRoot: v })} />
      <NumberField label="Tip kerf (fixed mode)" value={m.kerfTip} onChange={(v) => set({ kerfTip: v })} />
      <h3>Kerf vs. speed (auto mode)</h3>
      <KerfTableEditor rows={m.kerfTable ?? []} units={u} onChange={(rows) => set({ kerfTable: rows })} />
      <details>
        <summary>Kerf test (fills the table)</summary>
        <KerfTest material={m} machine={props.machine} onTable={(rows) => set({ kerfTable: rows })} />
      </details>
      <h3>Corner dwell (default)</h3>
      <label className="check">
        <input type="checkbox" checked={dwell.enabled} onChange={(e) => set({ cornerDwell: { ...dwell, enabled: e.target.checked } })} />
        Pause at sharp corners
      </label>
      <NumberField label="Corners sharper than (°)" value={dwell.angleDeg} onChange={(v) => set({ cornerDwell: { ...dwell, angleDeg: v } })} />
      <NumberField label="Pause (s)" value={dwell.seconds} onChange={(v) => set({ cornerDwell: { ...dwell, seconds: v } })} />
    </Shell>
  );
}
