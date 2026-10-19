import type { ProfileTransform, Transforms } from '../core/cut/transform';
import { NumInput } from './Fields';

interface Props {
  value: Transforms;
  onChange: (t: Transforms, opts?: { resetPlan?: boolean }) => void;
  units: string;
}

type Side = 'root' | 'tip';
/**
 * Fields that "link root & tip" keeps equal. Twist and move are always per profile (moving both
 * together changes nothing: the part is placed on the machine automatically).
 */
const LINKED: (keyof ProfileTransform)[] = ['scale', 'pivot', 'pivotPoint'];

export function TransformPanel({ value: t, onChange, units }: Props) {
  const set = (side: Side, patch: Partial<ProfileTransform>) => {
    const next: Transforms = { ...t, [side]: { ...t[side], ...patch } };
    if (t.link) {
      const other: Side = side === 'root' ? 'tip' : 'root';
      const shared = Object.fromEntries(Object.entries(patch).filter(([k]) => LINKED.includes(k as keyof ProfileTransform)));
      next[other] = { ...next[other], ...shared };
    }
    onChange(next);
  };
  const row = (label: string, cell: (side: Side) => React.ReactNode, title?: string) => (
    <div className="xf-row" title={title}>
      <span>{label}</span>
      {cell('root')}
      {cell('tip')}
    </div>
  );
  const chordLabel = (side: Side) => (t[side].le === null && t[side].te === null ? 'auto' : 'picked');

  return (
    <section>
      <h2>Transforms</h2>
      <div className="xf-row xf-head">
        <span />
        <span style={{ color: 'var(--root)' }}>Root</span>
        <span style={{ color: 'var(--tip)' }}>Tip</span>
      </div>
      {row(
        'Twist (°)',
        (side) => <NumInput value={t[side].twistDeg} step={0.5} aria-label={`${side} twist`} onChange={(v) => set(side, { twistDeg: v })} />,
        'Positive = leading edge up',
      )}
      <small className="hint warn-hint">
        Extra twist, <b>added on top of</b> any twist already drawn in the CAD profiles. If your DXFs already include washout, leave this at 0.
        Positive = leading edge up.
      </small>
      {row('Pivot', (side) => (
        <select value={t[side].pivot} aria-label={`${side} pivot`} onChange={(e) => set(side, { pivot: e.target.value as ProfileTransform['pivot'] })}>
          <option value="quarter">25% chord</option>
          <option value="le">LE</option>
          <option value="te">TE</option>
          <option value="point">Point</option>
        </select>
      ))}
      {(t.root.pivot === 'point' || t.tip.pivot === 'point') &&
        row(`Pivot X, Y (${units})`, (side) =>
          t[side].pivot === 'point' ? (
            <span className="xf-pair">
              <NumInput value={t[side].pivotPoint.x} aria-label={`${side} pivot x`} onChange={(v) => set(side, { pivotPoint: { ...t[side].pivotPoint, x: v } })} />
              <NumInput value={t[side].pivotPoint.y} aria-label={`${side} pivot y`} onChange={(v) => set(side, { pivotPoint: { ...t[side].pivotPoint, y: v } })} />
            </span>
          ) : (
            <span />
          ),
        )}
      {row('LE / TE', (side) => (
        <span className="xf-pair">
          <span className="hint" style={{ margin: 0 }}>{chordLabel(side)}</span>
          {chordLabel(side) === 'picked' && (
            <button title="Back to automatic LE/TE (ignores tabs)" onClick={() => set(side, { le: null, te: null })}>
              auto
            </button>
          )}
        </span>
      ), 'Automatic LE/TE ignore straight tabs. To pick your own, click the profile outline on the canvas and choose “Use as LE / TE here”.')}
      {row('Scale', (side) => <NumInput value={t[side].scale} step={0.01} aria-label={`${side} scale`} onChange={(v) => set(side, { scale: v })} />)}
      {row(`Move X (${units})`, (side) => <NumInput value={t[side].move.x} step={0.05} aria-label={`${side} move x`} onChange={(v) => set(side, { move: { ...t[side].move, x: v } })} />)}
      {row(`Move Y (${units})`, (side) => <NumInput value={t[side].move.y} step={0.05} aria-label={`${side} move y`} onChange={(v) => set(side, { move: { ...t[side].move, y: v } })} />)}
      <label className="check">
        <input
          type="checkbox"
          checked={t.link}
          onChange={(e) => {
            const link = e.target.checked;
            // turning the link on copies the root's shared settings to the tip
            const tip = link ? { ...t.tip, ...Object.fromEntries(LINKED.map((k) => [k, t.root[k]])) } : t.tip;
            onChange({ ...t, link, tip });
          }}
        />
        Link root &amp; tip (scale, pivot)
      </label>
      <div className="row-buttons">
        <label className="check" title="Mirror both profiles left-right about their pivots (cut TE-first)">
          <input type="checkbox" checked={t.flipH} onChange={(e) => onChange({ ...t, flipH: e.target.checked }, { resetPlan: true })} />
          Flip horizontal
        </label>
        <label className="check" title="Mirror both profiles top-bottom about their pivots (cut upside down)">
          <input type="checkbox" checked={t.flipV} onChange={(e) => onChange({ ...t, flipV: e.target.checked }, { resetPlan: true })} />
          Flip vertical
        </label>
      </div>
      <small className="hint">Flips apply to both profiles and reset the cut plan (segment numbering changes). Both flips together = rotate 180°.</small>
    </section>
  );
}
