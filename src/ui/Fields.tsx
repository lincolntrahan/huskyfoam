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

/**
 * Number input for an optional setting: blank means not set. `positive` also treats 0 as not set.
 * It keeps the text as typed, so "0" on the way to "0.001" stays in the box.
 */
export function OptionalNumberField(props: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  positive?: boolean;
  placeholder?: string;
  title?: string;
}) {
  const parse = (t: string) => {
    const v = parseFloat(t);
    return Number.isFinite(v) && (!props.positive || v > 0) ? v : undefined;
  };
  const [text, setText] = useState(props.value === undefined ? '' : show(props.value));
  useEffect(() => {
    if (parse(text) !== props.value) setText(props.value === undefined ? '' : show(props.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  return (
    <label className="field" title={props.title}>
      <span>{props.label}</span>
      <input
        type="number"
        step="any"
        min={0}
        placeholder={props.placeholder ?? 'not set'}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          props.onChange(parse(e.target.value));
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

/** Bare number input (no label) for compact grids. */
export function NumInput(props: { value: number; onChange: (v: number) => void; step?: number; title?: string; 'aria-label'?: string }) {
  const [text, setText] = useState(show(props.value));
  useEffect(() => {
    if (parseFloat(text) !== props.value) setText(show(props.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  return (
    <input
      type="number"
      step={props.step ?? 'any'}
      title={props.title}
      aria-label={props['aria-label']}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) props.onChange(v);
      }}
    />
  );
}
