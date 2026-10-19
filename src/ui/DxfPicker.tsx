import { useEffect, useMemo, useRef, useState } from 'react';
import type { Vec2 } from '../core/geom/vec';
import type { LoadedProfile } from '../core/io/loadProfile';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const pts = (list: Vec2[]) => list.map((p) => `${p.x},${-p.y}`).join(' ');

function bounds(loaded: LoadedProfile): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Vec2) => {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, -p.y); y1 = Math.max(y1, -p.y);
  };
  loaded.edges.forEach((e) => e.pts.forEach(add));
  loaded.texts.forEach((t) => add(t.at));
  if (!Number.isFinite(x0)) return null;
  const pad = Math.max(x1 - x0, y1 - y0, 1) * 0.06;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/**
 * One DXF file's entities, for choosing what to cut. Click an entity to include/exclude it;
 * drag a box to include everything inside (Shift-drag excludes). Right- or middle-drag pans,
 * the wheel zooms, double-click fits.
 */
export function DxfPicker(props: {
  label: string;
  color: string;
  loaded: LoadedProfile;
  /** null = automatic pick. */
  selection: number[] | null;
  onChange: (sel: number[] | null) => void;
}) {
  const { loaded } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const fit = useMemo(() => bounds(loaded), [loaded]);
  const [view, setView] = useState<Box | null>(fit);
  useEffect(() => setView(fit), [fit]);
  // the live box is kept in a ref (events can outrun re-renders); state only drives drawing it
  const dragRef = useRef<{ a: Vec2; b: Vec2; exclude: boolean } | null>(null);
  const [drag, setDragState] = useState<{ a: Vec2; b: Vec2; exclude: boolean } | null>(null);
  const setDrag = (d: { a: Vec2; b: Vec2; exclude: boolean } | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const pan = useRef<{ x: number; y: number; box: Box } | null>(null);

  const selected = new Set(loaded.selected);
  const used = new Set(loaded.used);
  const set = (next: Set<number>) => props.onChange([...next].sort((a, b) => a - b));

  const toSvg = (e: { clientX: number; clientY: number }): Vec2 => {
    const svg = svgRef.current!;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: q.x, y: q.y };
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        if (!v) return v;
        const c = toSvg(e);
        const k = Math.exp(e.deltaY * 0.0015);
        return { x: c.x - (c.x - v.x) * k, y: c.y - (c.y - v.y) * k, w: v.w * k, h: v.h * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view !== null]);

  if (!view) return null;
  const unit = Math.max(view.w, view.h) / 100;
  const nIn = loaded.selected.length;

  const finishBox = (d: { a: Vec2; b: Vec2; exclude: boolean }) => {
    const x0 = Math.min(d.a.x, d.b.x), x1 = Math.max(d.a.x, d.b.x);
    const y0 = Math.min(d.a.y, d.b.y), y1 = Math.max(d.a.y, d.b.y);
    if (x1 - x0 < unit * 0.5 && y1 - y0 < unit * 0.5) return; // just a click on empty space
    const inside = loaded.edges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.pts.every((p) => p.x >= x0 && p.x <= x1 && -p.y >= y0 && -p.y <= y1))
      .map(({ i }) => i);
    const next = new Set(selected);
    inside.forEach((i) => (d.exclude ? next.delete(i) : next.add(i)));
    set(next);
  };

  return (
    <div className="dxf-picker">
      <div className="dxf-head">
        <span>
          <span className="swatch" style={{ background: props.color }} />
          <b>{props.label}</b> · {nIn} of {loaded.edges.length} entities in use
          {loaded.texts.length ? ` · ${loaded.texts.length} text (never cut)` : ''}
          {' · '}
          {loaded.profile ? <span className="ok-text">closed outline ✓</span> : <span className="err-text">no closed outline</span>}
        </span>
        <span className="row-buttons" style={{ margin: 0 }}>
          <button className={props.selection === null ? 'active' : ''} onClick={() => props.onChange(null)} title="Largest closed outline; text and stray geometry left out">
            Auto pick
          </button>
          <button onClick={() => set(new Set(loaded.edges.map((_, i) => i)))}>Include all</button>
          <button onClick={() => props.onChange([])}>Clear</button>
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          try {
            svgRef.current!.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
          if (e.button === 1 || e.button === 2) pan.current = { x: e.clientX, y: e.clientY, box: view };
          else {
            const p = toSvg(e);
            setDrag({ a: p, b: p, exclude: e.shiftKey });
          }
        }}
        onPointerMove={(e) => {
          const pn = pan.current;
          if (pn) {
            const r = svgRef.current!.getBoundingClientRect();
            const s = Math.max(pn.box.w / r.width, pn.box.h / r.height);
            setView({ ...pn.box, x: pn.box.x - (e.clientX - pn.x) * s, y: pn.box.y - (e.clientY - pn.y) * s });
          } else if (dragRef.current) setDrag({ ...dragRef.current, b: toSvg(e) });
        }}
        onPointerUp={() => {
          pan.current = null;
          if (dragRef.current) finishBox(dragRef.current);
          setDrag(null);
        }}
        onDoubleClick={() => setView(fit)}
      >
        <g fill="none">
          {loaded.edges.map((e, i) => {
            const inSel = selected.has(i);
            const inUse = used.has(i);
            const stroke = inUse ? props.color : inSel ? 'var(--warn)' : 'var(--muted)';
            return (
              <g key={i}>
                <polyline
                  points={pts(e.pts)}
                  stroke={stroke}
                  strokeWidth={inSel ? 2 : 1}
                  strokeDasharray={inSel ? undefined : '4 3'}
                  opacity={inSel ? 1 : 0.6}
                  vectorEffect="non-scaling-stroke"
                />
                <polyline
                  className="clickable"
                  points={pts(e.pts)}
                  stroke="transparent"
                  strokeWidth={12}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={() => {
                    const next = new Set(selected);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    set(next);
                  }}
                >
                  <title>{`${e.source} ${i + 1}: ${inUse ? 'in the outline' : inSel ? 'included, but not part of the closed outline' : 'excluded'} (click to toggle)`}</title>
                </polyline>
              </g>
            );
          })}
          {loaded.texts.map((t, i) => (
            <text key={`t${i}`} x={t.at.x} y={-t.at.y} fontSize={t.height} fill="var(--muted)" fontStyle="italic" pointerEvents="none">
              {t.text}
            </text>
          ))}
          {drag && (
            <rect
              x={Math.min(drag.a.x, drag.b.x)}
              y={Math.min(drag.a.y, drag.b.y)}
              width={Math.abs(drag.b.x - drag.a.x)}
              height={Math.abs(drag.b.y - drag.a.y)}
              fill={drag.exclude ? 'var(--err-bg)' : 'var(--sel)'}
              stroke={drag.exclude ? 'var(--err)' : 'var(--accent)'}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
      </svg>
    </div>
  );
}
