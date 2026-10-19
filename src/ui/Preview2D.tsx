import { useEffect, useMemo, useRef, useState } from 'react';
import type { CutResult } from '../core/cut/pipeline';
import type { Profile } from '../core/geom/profile';
import type { Vec2 } from '../core/geom/vec';
import type { MachinePreset } from '../core/types';

export interface Layers {
  profiles: boolean;
  kerf: boolean;
  wires: boolean;
  carriages: boolean;
}

interface Props {
  root: Profile | null;
  tip: Profile | null;
  offset: Vec2;
  result: CutResult | null;
  machine: MachinePreset;
  layers: Layers;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// World Y is up; SVG Y is down. Everything is drawn with y negated.
const pts = (list: Vec2[], o: Vec2 = { x: 0, y: 0 }) => list.map((p) => `${(p.x + o.x).toFixed(5)},${(-(p.y + o.y)).toFixed(5)}`).join(' ');

function boundsOf(lists: Vec2[][]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lists) for (const p of l) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, -p.y); y1 = Math.max(y1, -p.y);
  }
  if (!Number.isFinite(x0)) return null;
  const pad = Math.max(x1 - x0, y1 - y0, 1) * 0.06;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

export function Preview2D({ root, tip, offset, result, machine, layers }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const shift = (p: Profile | null) => (p ? p.pts.map((q) => ({ x: q.x + offset.x, y: q.y + offset.y })) : []);
  const rootPts = useMemo(() => shift(root), [root, offset]);
  const tipPts = useMemo(() => shift(tip), [tip, offset]);
  const carriage = useMemo(() => {
    if (!result?.moves.length) return { left: [] as Vec2[], right: [] as Vec2[] };
    const all = [result.start, ...result.moves];
    return { left: all.map((m) => m.left), right: all.map((m) => m.right) };
  }, [result]);

  const content = useMemo(() => {
    const lists = [rootPts, tipPts];
    if (layers.carriages) lists.push(carriage.left, carriage.right);
    return boundsOf(lists);
  }, [rootPts, tipPts, carriage, layers.carriages]);

  const [view, setView] = useState<Box | null>(null);
  const fitKey = `${root?.pts.length}|${tip?.pts.length}|${layers.carriages}`;
  useEffect(() => setView(content), [fitKey]); // refit when the geometry or layer set changes
  const vb = view ?? content;

  // Pan & zoom
  const drag = useRef<{ x: number; y: number; box: Box } | null>(null);
  const toWorld = (e: { clientX: number; clientY: number }, box: Box) => {
    const r = svgRef.current!.getBoundingClientRect();
    const s = Math.max(box.w / r.width, box.h / r.height);
    const cx = box.x + box.w / 2 + (e.clientX - r.left - r.width / 2) * s;
    const cy = box.y + box.h / 2 + (e.clientY - r.top - r.height / 2) * s;
    return { cx, cy, s };
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const box = v ?? content;
        if (!box) return v;
        const { cx, cy } = toWorld(e, box);
        const k = Math.exp(e.deltaY * 0.0015);
        return { x: cx - (cx - box.x) * k, y: cy - (cy - box.y) * k, w: box.w * k, h: box.h * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [content]);

  if (!vb) {
    return (
      <div className="canvas-wrap">
        <div className="empty">Load a root and a tip DXF (or the V-tail example) to see the cut.</div>
      </div>
    );
  }

  const unit = Math.max(vb.w, vb.h) / 100; // ~1% of the view, for marker and label sizes
  const wireLines = (() => {
    const ks = result?.kerfStations ?? [];
    if (!layers.wires || ks.length < 2) return [];
    const every = Math.max(1, Math.floor(ks.length / 90));
    return ks.filter((s, i) => i % every === 0 || s.boundary);
  })();

  const markers = (profile: Profile | null, splits: number[], color: string, dy: number) =>
    profile &&
    splits.map((idx, k) => {
      const p = profile.pts[idx];
      const x = p.x + offset.x;
      const y = -(p.y + offset.y);
      return (
        <g key={`${color}-${k}`}>
          <circle cx={x} cy={y} r={unit * (k === 0 ? 0.9 : 0.55)} fill={k === 0 ? color : 'var(--canvas)'} stroke={color} strokeWidth={unit * 0.2} />
          <text x={x + unit * 0.9} y={y + dy * unit} fontSize={unit * 1.6} fill={color}>
            {k === 0 ? `${k + 1} start` : k + 1}
          </text>
        </g>
      );
    });

  const [tx0, tx1] = machine.travel.x;
  const [ty0, ty1] = machine.travel.y;
  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, box: vb };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const r = svgRef.current!.getBoundingClientRect();
          const s = Math.max(d.box.w / r.width, d.box.h / r.height);
          setView({ ...d.box, x: d.box.x - (e.clientX - d.x) * s, y: d.box.y - (e.clientY - d.y) * s });
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => setView(content)}
      >
        <g strokeLinejoin="round" fill="none">
          {layers.carriages && (
            <>
              <rect x={tx0} y={-ty1} width={tx1 - tx0} height={ty1 - ty0} stroke="var(--muted)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" strokeWidth={1} />
              <polyline points={pts(carriage.left)} stroke="var(--left)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
              <polyline points={pts(carriage.right)} stroke="var(--right)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
            </>
          )}
          {wireLines.map((s, i) => (
            <line key={i} x1={s.r.x} y1={-s.r.y} x2={s.t.x} y2={-s.t.y} stroke="var(--wire)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {layers.profiles && (
            <>
              <polygon points={pts(rootPts)} stroke="var(--root)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <polygon points={pts(tipPts)} stroke="var(--tip)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </>
          )}
          {layers.kerf && result && result.kerfStations.length > 0 && (
            <>
              <polyline points={pts(result.kerfStations.map((s) => s.r))} stroke="var(--root)" strokeDasharray="5 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <polyline points={pts(result.kerfStations.map((s) => s.t))} stroke="var(--tip)" strokeDasharray="5 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </>
          )}
        </g>
        {result && markers(root, result.rootSplits, 'var(--root)', -0.6)}
        {result && markers(tip, result.tipSplits, 'var(--tip)', 2)}
      </svg>
    </div>
  );
}
