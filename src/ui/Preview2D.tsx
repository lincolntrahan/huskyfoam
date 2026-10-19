import { useEffect, useMemo, useRef, useState } from 'react';
import type { CutResult } from '../core/cut/pipeline';
import type { Profile } from '../core/geom/profile';
import { add, normalize, perpR, scale, sub, type Vec2 } from '../core/geom/vec';
import { insertOutAndBack, insertPointOnLine, insertRunOut, removeStep, reverseStep, setPoint, setSpeed } from '../core/plan/edit';
import type { CutPlan, PlanPoint } from '../core/plan/model';
import type { Rect } from '../core/plan/templates';
import type { PathPt } from '../core/plan/walk';
import type { MachinePreset } from '../core/types';

export interface Layers {
  profiles: boolean;
  kerf: boolean;
  plan: boolean;
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
  block: Rect;
  plan: CutPlan | null;
  onPlanChange: (p: CutPlan) => void;
  outBackDistance: number;
  selectedStep: number | null;
  onSelectStep: (i: number | null) => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Menu =
  | { kind: 'split'; k: number; sx: number; sy: number }
  | { kind: 'line'; step: number; at: Vec2; sx: number; sy: number };

interface Drawing {
  fromSplit: number;
  pts: Vec2[];
  cursor: Vec2 | null;
}

interface Run {
  step: number;
  speed: PathPt['speed'];
  line: boolean;
  r: Vec2[];
  t: Vec2[];
}

// World Y is up; SVG Y is down. Everything is drawn with y negated.
const pts = (list: Vec2[]) => list.map((p) => `${p.x.toFixed(5)},${(-p.y).toFixed(5)}`).join(' ');

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

/** Group consecutive moves of the walked path by (step, speed). */
function runsOf(path: PathPt[]): Run[] {
  const runs: Run[] = [];
  for (let i = 1; i < path.length; i++) {
    const p = path[i];
    const last = runs[runs.length - 1];
    if (last && last.step === p.step && last.speed === p.speed) {
      last.r.push(p.r);
      last.t.push(p.t);
    } else runs.push({ step: p.step, speed: p.speed, line: p.line, r: [path[i - 1].r, p.r], t: [path[i - 1].t, p.t] });
  }
  return runs;
}

const speedColor = (s: PathPt['speed']) => (s === 'jog' ? 'var(--jog)' : s === 'gap' ? 'var(--err)' : 'var(--cut)');

export function Preview2D(props: Props) {
  const { root, tip, offset, result, machine, layers, block, plan, onPlanChange } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const shiftPts = (p: Profile | null) => (p ? p.pts.map((q) => ({ x: q.x + offset.x, y: q.y + offset.y })) : []);
  const rootPts = useMemo(() => shiftPts(root), [root, offset]);
  const tipPts = useMemo(() => shiftPts(tip), [tip, offset]);
  const n = result?.stats.segments ?? 0;
  const carriage = useMemo(() => {
    if (!result?.moves.length) return { left: [] as Vec2[], right: [] as Vec2[] };
    const all = [result.start, ...result.moves];
    return { left: all.map((m) => m.left), right: all.map((m) => m.right) };
  }, [result]);
  const runs = useMemo(() => (result ? runsOf(result.path) : []), [result]);

  const content = useMemo(() => {
    const lists = [rootPts, tipPts];
    if (layers.carriages) lists.push(carriage.left, carriage.right);
    if (block.w > 0 && block.h > 0) lists.push([{ x: block.x, y: block.y }, { x: block.x + block.w, y: block.y + block.h }]);
    return boundsOf(lists);
  }, [rootPts, tipPts, carriage, layers.carriages, block]);

  const [view, setView] = useState<Box | null>(null);
  const fitKey = `${root?.pts.length}|${tip?.pts.length}|${layers.carriages}`;
  useEffect(() => setView(content), [fitKey]); // refit when the geometry or layer set changes
  const vb = view ?? content;

  const [menu, setMenu] = useState<Menu | null>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const pan = useRef<{ x: number; y: number; box: Box; moved: boolean } | null>(null);
  const pointDrag = useRef<{ id: string; role: 'p' | 'r' | 't' } | null>(null);

  const toWorld = (clientX: number, clientY: number): Vec2 => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const w = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: w.x, y: -w.y };
  };
  // Keep receiving moves while dragging outside the svg; harmless if the pointer is already gone.
  const capture = (pointerId: number) => {
    try {
      svgRef.current?.setPointerCapture(pointerId);
    } catch {
      /* pointer no longer active */
    }
  };
  const toWrap = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { sx: clientX - r.left, sy: clientY - r.top };
  };

  // Wheel zoom around the cursor
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const box = v ?? content;
        if (!box) return v;
        const w = toWorld(e.clientX, e.clientY);
        const cx = w.x;
        const cy = -w.y;
        const k = Math.exp(e.deltaY * 0.0015);
        return { x: cx - (cx - box.x) * k, y: cy - (cy - box.y) * k, w: box.w * k, h: box.h * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [content, vb !== null]);

  // Drawing a run-out: Enter finishes at the last point, Escape cancels.
  const finishDrawing = (endSplit: number | null) => {
    if (!drawing || !plan) return;
    const free: PlanPoint[] = [];
    for (const p of drawing.pts) {
      const last = free[free.length - 1];
      if (last?.kind === 'free' && Math.hypot(last.p.x - p.x, last.p.y - p.y) < 1e-9) continue;
      free.push({ kind: 'free', p });
    }
    if (free.length || endSplit !== null) onPlanChange(insertRunOut(plan, drawing.fromSplit, free, endSplit, n));
    setDrawing(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawing(null);
        setMenu(null);
      } else if (e.key === 'Enter' && drawing) finishDrawing(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!vb) {
    return (
      <div className="canvas-wrap" ref={wrapRef}>
        <div className="empty">Load a root and a tip DXF (or the V-tail example) to see the cut.</div>
      </div>
    );
  }

  const unit = Math.max(vb.w, vb.h) / 100; // ~1% of the view, for marker and label sizes
  const splitPos = (profile: Profile | null, splits: number[] | undefined, k: number): Vec2 | null => {
    const idx = splits?.[k];
    if (!profile || idx === undefined) return null;
    return { x: profile.pts[idx].x + offset.x, y: profile.pts[idx].y + offset.y };
  };

  const outAndBackAt = (k: number) => {
    if (!plan || !result || !root || !tip) return;
    const outward = (profile: Profile, splits: number[], side: 'r' | 't'): { from: Vec2; dir: Vec2 } => {
      const from = splitPos(profile, splits, k)!;
      const corner = result.kerfStations.filter((s) => s.corner && s.seg === k).map((s) => s[side]);
      const avg = corner.reduce((a, p) => add(a, scale(p, 1 / corner.length)), { x: 0, y: 0 });
      let dir = normalize(sub(avg, from));
      if (Math.hypot(dir.x, dir.y) < 0.5) {
        const N = profile.pts.length;
        const i = splits[k];
        dir = normalize(perpR(sub(profile.pts[(i + 1) % N], profile.pts[(i - 1 + N) % N])));
      }
      return { from, dir };
    };
    const r = outward(root, result.rootSplits, 'r');
    const t = outward(tip, result.tipSplits, 't');
    const d = props.outBackDistance;
    onPlanChange(insertOutAndBack(plan, k, { r: add(r.from, scale(r.dir, d)), t: add(t.from, scale(t.dir, d)) }, n));
  };

  const onSplitClick = (k: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (drawing) {
      finishDrawing(k);
      return;
    }
    setMenu({ kind: 'split', k, ...toWrap(e.clientX, e.clientY) });
  };

  const markers = (profile: Profile | null, splits: number[] | undefined, color: string, dy: number) =>
    profile &&
    splits?.map((idx, k) => {
      const p = profile.pts[idx];
      const x = p.x + offset.x;
      const y = -(p.y + offset.y);
      return (
        <g key={`${color}-${k}`} className="clickable" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => onSplitClick(k, e)}>
          <circle cx={x} cy={y} r={unit * 1.2} fill="transparent" />
          <circle cx={x} cy={y} r={unit * (k === 0 ? 0.9 : 0.55)} fill={k === 0 ? color : 'var(--canvas)'} stroke={color} strokeWidth={unit * 0.2} />
          <text x={x + unit * 0.9} y={y + dy * unit} fontSize={unit * 1.6} fill={color}>
            {k === 0 ? `${k + 1} start` : k + 1}
          </text>
        </g>
      );
    });

  const wireLines = (() => {
    const ks = result?.kerfStations ?? [];
    if (!layers.wires || ks.length < 2) return [];
    const every = Math.max(1, Math.floor(ks.length / 90));
    return ks.filter((s, i) => i % every === 0 || s.boundary);
  })();

  const handles =
    plan && layers.plan
      ? Object.entries(plan.points).flatMap(([id, p]) => {
          const h = (role: 'p' | 'r' | 't', at: Vec2, color: string) => (
            <circle
              key={`${id}-${role}`}
              className="handle"
              cx={at.x}
              cy={-at.y}
              r={unit * 0.7}
              fill="var(--canvas)"
              stroke={color}
              strokeWidth={unit * 0.25}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (p.kind === 'free' && e.shiftKey) {
                  onPlanChange(setPoint(plan, id, { kind: 'freePair', r: p.p, t: p.p }));
                  pointDrag.current = { id, role: 'r' };
                } else pointDrag.current = { id, role };
                capture(e.pointerId);
              }}
            >
              <title>{p.kind === 'free' ? 'Drag to move (Shift-drag: separate root/tip)' : role === 'r' ? 'Root end' : 'Tip end'}</title>
            </circle>
          );
          if (p.kind === 'free') return [h('p', p.p, 'var(--text)')];
          if (p.kind === 'freePair')
            return [
              <line key={`${id}-link`} x1={p.r.x} y1={-p.r.y} x2={p.t.x} y2={-p.t.y} stroke="var(--muted)" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />,
              h('r', p.r, 'var(--root)'),
              h('t', p.t, 'var(--tip)'),
            ];
          return [];
        })
      : [];

  const lastDrawPt = drawing ? (drawing.pts[drawing.pts.length - 1] ?? splitPos(root, result?.rootSplits, drawing.fromSplit)) : null;

  const [tx0, tx1] = machine.travel.x;
  const [ty0, ty1] = machine.travel.y;
  const menuItem = (label: string, action: () => void) => (
    <button
      key={label}
      onClick={() => {
        action();
        setMenu(null);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={(e) => {
          pan.current = { x: e.clientX, y: e.clientY, box: vb, moved: false };
          capture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const pd = pointDrag.current;
          if (pd && plan) {
            const w = toWorld(e.clientX, e.clientY);
            const p = plan.points[pd.id];
            if (p?.kind === 'free') onPlanChange(setPoint(plan, pd.id, { kind: 'free', p: w }));
            else if (p?.kind === 'freePair') onPlanChange(setPoint(plan, pd.id, pd.role === 't' ? { ...p, t: w } : { ...p, r: w }));
            return;
          }
          const d = pan.current;
          if (d) {
            if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
            d.moved = true;
            const r = svgRef.current!.getBoundingClientRect();
            const s = Math.max(d.box.w / r.width, d.box.h / r.height);
            setView({ ...d.box, x: d.box.x - (e.clientX - d.x) * s, y: d.box.y - (e.clientY - d.y) * s });
          } else if (drawing) setDrawing({ ...drawing, cursor: toWorld(e.clientX, e.clientY) });
        }}
        onPointerUp={(e) => {
          if (pointDrag.current) {
            pointDrag.current = null;
            return;
          }
          const d = pan.current;
          pan.current = null;
          if (d && !d.moved) {
            // a click on empty canvas
            if (menu) setMenu(null);
            else if (drawing) setDrawing({ ...drawing, pts: [...drawing.pts, toWorld(e.clientX, e.clientY)] });
          }
        }}
        onDoubleClick={() => {
          if (drawing) finishDrawing(null);
          else setView(content);
        }}
      >
        <defs>
          {(['cut', 'jog'] as const).map((s) => (
            <marker key={s} id={`arrow-${s}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth={unit * 1.6} markerHeight={unit * 1.6} orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L10,5 L0,10 z" fill={speedColor(s)} />
            </marker>
          ))}
        </defs>
        <g strokeLinejoin="round" fill="none">
          {block.w > 0 && block.h > 0 && (
            <rect x={block.x} y={-(block.y + block.h)} width={block.w} height={block.h} fill="var(--block)" stroke="var(--block-edge)" strokeDasharray="6 3" vectorEffect="non-scaling-stroke" />
          )}
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
              <polyline points={pts(result.kerfStations.map((s) => s.r))} stroke="var(--root)" strokeDasharray="5 3" strokeWidth={0.8} opacity={0.6} vectorEffect="non-scaling-stroke" />
              <polyline points={pts(result.kerfStations.map((s) => s.t))} stroke="var(--tip)" strokeDasharray="5 3" strokeWidth={0.8} opacity={0.6} vectorEffect="non-scaling-stroke" />
            </>
          )}
          {layers.plan &&
            runs.map((run, i) => {
              const color = speedColor(run.speed);
              const sel = props.selectedStep === run.step;
              const dash = run.speed === 'cut' ? undefined : '6 4';
              const width = sel ? 3.5 : 2;
              const mid = Math.floor((run.r.length - 1) / 2);
              const arrow = run.speed === 'gap' ? undefined : `url(#arrow-${run.speed})`;
              const clickLine = (e: React.MouseEvent) => {
                e.stopPropagation();
                if (drawing) return;
                props.onSelectStep(run.step);
                if (run.line && run.step >= 0) setMenu({ kind: 'line', step: run.step, at: toWorld(e.clientX, e.clientY), ...toWrap(e.clientX, e.clientY) });
              };
              return (
                <g key={i}>
                  <polyline points={pts(run.t)} stroke={color} strokeWidth={width * 0.6} strokeDasharray={dash} opacity={0.55} vectorEffect="non-scaling-stroke" />
                  <polyline points={pts(run.r)} stroke={color} strokeWidth={width} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
                  {arrow && run.r.length >= 2 && <polyline points={pts([run.r[mid], run.r[mid + 1]])} stroke="none" markerEnd={arrow} />}
                  <polyline className="clickable" points={pts(run.r)} stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={clickLine} />
                  <polyline className="clickable" points={pts(run.t)} stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={clickLine} />
                  {run.step >= 0 && run.speed !== 'gap' && (
                    <text x={run.r[mid].x} y={-run.r[mid].y - unit * 0.8} fontSize={unit * 1.3} fill={color} stroke="none" textAnchor="middle">
                      {run.step + 1}
                    </text>
                  )}
                </g>
              );
            })}
          {drawing && lastDrawPt && (
            <polyline
              points={pts([splitPos(root, result?.rootSplits, drawing.fromSplit)!, ...drawing.pts, ...(drawing.cursor ? [drawing.cursor] : [])])}
              stroke="var(--cut)"
              strokeDasharray="3 3"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
        {result && markers(root, result.rootSplits, 'var(--root)', -0.6)}
        {result && markers(tip, result.tipSplits, 'var(--tip)', 2)}
        {handles}
      </svg>

      {drawing && (
        <div className="banner">
          Drawing a run-out from split {drawing.fromSplit + 1}: click to add points, click a split marker to run back in, Enter or double-click to stop
          here, Esc to cancel.
        </div>
      )}

      {menu && plan && (
        <div className="popover" style={{ left: menu.sx, top: menu.sy }} onPointerDown={(e) => e.stopPropagation()}>
          {menu.kind === 'split' ? (
            <>
              <div className="popover-title">Split {menu.k + 1}</div>
              {menuItem('Run out from here…', () => setDrawing({ fromSplit: menu.k, pts: [], cursor: null }))}
              {menuItem(`Out-and-back here (${props.outBackDistance} ${machine.units})`, () => outAndBackAt(menu.k))}
            </>
          ) : (
            (() => {
              const s = plan.steps[menu.step];
              if (s?.kind !== 'line') return null;
              return (
                <>
                  <div className="popover-title">Step {menu.step + 1} ({s.speed})</div>
                  {menuItem(s.speed === 'cut' ? 'Make jog' : 'Make cut', () => onPlanChange(setSpeed(plan, menu.step, s.speed === 'cut' ? 'jog' : 'cut')))}
                  {menuItem('Insert point here', () => onPlanChange(insertPointOnLine(plan, menu.step, menu.at)))}
                  {menuItem('Reverse', () => onPlanChange(reverseStep(plan, menu.step)))}
                  {menuItem('Delete', () => onPlanChange(removeStep(plan, menu.step)))}
                </>
              );
            })()
          )}
          <button className="muted" onClick={() => setMenu(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
