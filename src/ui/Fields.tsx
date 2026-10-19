import { useEffect, useState } from 'react';

/** Number input that lets you type freely and only reports valid numbers. */
// Values set by the app (fits, templates) can have long tails; show at most 6 significant decimals.
const show = (v: number) => String(Number(v.toFixed(6)));

export function NumberField(props: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; hint?: string }) {
  const [text, setText] = useState(show(props.value));
  useEffect(() => {
    if (parseFloat(text) !== props.value) setText(show(props.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  return (
    <label className="field" title={props.hint}>
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step ?? 'any'}
        min={props.min}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
    </label>
  );
}

export function SelectField<T extends string>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
