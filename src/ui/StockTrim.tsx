import { useMemo, useState } from 'react';
import { kerfAt } from '../core/cut/kerfTable';
import { defaultStockTrim, stockTrim, type StockTrimSpec } from '../core/cut/stockTrim';
import type { JobSettings, MachinePreset } from '../core/types';
import { NumberField } from './Fields';
import { download } from './PresetEditor';

/** Kerf the job would use at this wire speed (a straight wire: both faces move at it). */
function kerfFor(job: JobSettings, speed: number) {
  return job.kerf.mode === 'auto' ? kerfAt(job.kerfTable, speed).kerf : (job.kerf.root + job.kerf.tip) / 2;
}

/**
 * Stock generation: trims a raw board to the distance between the profiles. The board lies
 * turned 90°, so its eventual left / right faces are cut as its front and back.
 */
export function StockTrimDialog(props: { job: JobSettings; machine: MachinePreset; length: number; thickness: number; onClose: () => void }) {
  const { job, machine } = props;
  const u = machine.units;
  const d = defaultStockTrim(u);
  const [spec, setSpec] = useState<StockTrimSpec>(() => ({
    length: props.length,
    thickness: props.thickness,
    setback: d.setback,
    trimFront: d.trimFront,
    backOffset: d.backOffset,
    kerf: kerfFor(job, job.cutSpeed),
    clearance: job.jogClearance,
    speed: job.cutSpeed,
  }));
  const set = (p: Partial<StockTrimSpec>) => setSpec((s) => ({ ...s, ...p }));
  const res = useMemo(
    () => stockTrim(spec, machine, { wireWatts: job.wireWatts, wireDiameter: job.wireDiameter }),
    [spec, machine, job.wireWatts, job.wireDiameter],
  );
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label="Stock generation">
        <header>
          <h2>Stock generation</h2>
          <button className="muted" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <small className="hint">
          Trims a raw board to length with a straight wire. Lay it on the floor turned 90° from how it will be cut, so its future left and right faces
          are at the front and back here. The wire cuts down through the front, pulls out, jogs over the board, cuts down through the back, steps back
          and cuts up through the waste.
        </small>
        <div className="modal-body">
          <h3>Confirm the stock</h3>
          <NumberField label={`Finished length (${u})`} value={spec.length} min={0} onChange={(v) => set({ length: v })} hint="Kept face to kept face: the distance between the profiles" />
          <NumberField label={`Board thickness (${u})`} value={spec.thickness} min={0} onChange={(v) => set({ thickness: v })} hint="Its height lying on the floor" />
          <h3>Place it</h3>
          <NumberField label={`X = 0 to the board's front (${u})`} value={spec.setback} min={0} onChange={(v) => set({ setback: v })} hint="How far back from the wire at home the raw board's front face sits" />
          <NumberField label={`Trim off the front (${u})`} value={spec.trimFront} min={0} onChange={(v) => set({ trimFront: v })} hint="Waste cut off the front to get a clean face" />
          <NumberField
            label={`Back step before cutting up (${u})`}
            value={spec.backOffset}
            min={0}
            onChange={(v) => set({ backOffset: v })}
            hint="After the back cut, the wire steps this far back into the waste and cuts back up, so the kept face is cut only once"
          />
          <h3>Wire</h3>
          <NumberField
            label={`Cut speed (${u}/min)`}
            value={spec.speed}
            min={0}
            onChange={(v) => set({ speed: v, ...(job.kerf.mode === 'auto' ? { kerf: kerfFor(job, v) } : {}) })}
          />
          <NumberField label={`Kerf, full width (${u})`} value={r3(spec.kerf)} min={0} onChange={(v) => set({ kerf: v })} hint="Each cut runs half of it into the waste" />
          <NumberField label={`Clearance above the board (${u})`} value={spec.clearance} min={0} onChange={(v) => set({ clearance: v })} />
          <StockTrimPreview spec={spec} res={res} units={u} />
          {!res.errors.length && (
            <small className="hint">
              Wire centre: front cut at X = {r3(res.front)}, back cut at X = {r3(res.back)}, back up at X = {r3(res.up)}; travel at Y = {r3(res.safe)}.
            </small>
          )}
        </div>
        {res.errors.map((e) => (
          <div key={e} className="msg err">
            {e}
          </div>
        ))}
        <footer>
          <span className="spacer" />
          <button onClick={props.onClose}>Close</button>
          <button className="primary" disabled={!res.gcode} onClick={() => download(`stock-trim-${r3(spec.length)}${u}.nc`, res.gcode)}>
            Download G-code
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Side view: the board (kept part shaded), the wire path (cuts solid, jogs dashed) and the finished length. */
function StockTrimPreview({ spec, res, units }: { spec: StockTrimSpec; res: ReturnType<typeof stockTrim>; units: string }) {
  const pts = res.path.map((s) => s.p);
  const boardEnd = res.up + Math.max(spec.backOffset, spec.length * 0.08);
  const xs = [...pts.map((p) => p.x), boardEnd];
  const ys = [...pts.map((p) => p.y), spec.thickness];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  const w = x1 - x0 || 1;
  const pad = w * 0.04;
  const h = y1 || 1;
  const vb = `${x0 - pad} ${-h - pad} ${w + 2 * pad} ${h + 2 * pad + w * 0.06}`;
  const keptA = spec.setback + spec.trimFront;
  const keptB = keptA + spec.length;
  const font = w * 0.03;
  return (
    <svg className="stock-preview" viewBox={vb} role="img" aria-label="Side view of the trim cuts">
      <rect x={spec.setback} y={-spec.thickness} width={Math.max(0, boardEnd - spec.setback)} height={spec.thickness} fill="var(--block-fill, rgba(255,170,60,0.08))" stroke="var(--muted)" strokeDasharray="none" vectorEffect="non-scaling-stroke" />
      <rect x={keptA} y={-spec.thickness} width={Math.max(0, spec.length)} height={spec.thickness} fill="rgba(47,123,255,0.18)" stroke="var(--accent)" vectorEffect="non-scaling-stroke" />
      <line x1={x0 - pad} y1={0} x2={x1 + pad} y2={0} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
      {res.path.slice(1).map((s, i) => (
        <line
          key={i}
          x1={res.path[i].p.x}
          y1={-res.path[i].p.y}
          x2={s.p.x}
          y2={-s.p.y}
          stroke="var(--tip)"
          strokeWidth={2}
          strokeDasharray={s.kind === 'jog' ? '5 4' : undefined}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <text x={(keptA + keptB) / 2} y={font * 1.6} fontSize={font} textAnchor="middle" fill="var(--text)">
        {Math.round(spec.length * 1000) / 1000} {units}
      </text>
      <text x={spec.setback} y={font * 1.6} fontSize={font * 0.8} textAnchor="start" fill="var(--muted)">
        front
      </text>
      <text x={boardEnd} y={font * 1.6} fontSize={font * 0.8} textAnchor="end" fill="var(--muted)">
        back
      </text>
    </svg>
  );
}
