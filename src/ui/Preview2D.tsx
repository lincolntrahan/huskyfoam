import { useEffect, useMemo, useRef, useState } from 'react';
import type { CutResult } from '../core/cut/pipeline';
import { nearestS } from '../core/geom/arc';
import type { Profile } from '../core/geom/profile';
import { add, normalize, perpR, scale, sub, type Vec2 } from '../core/geom/vec';
import { insertOutAndBack, insertPointOnLine, insertRunOut, removeStep, reverseStep, setPoint, setSpeed } from '../core/plan/edit';
import type { CutPlan, PlanPoint } from '../core/plan/model';
import type { Rect } from '../core/plan/templates';
import type { PathPt } from '../core/plan/walk';
import { addPin, addSplit, movePin, moveSplit, removePin, removeSplit, setLoopStart, type Side, type SyncEdit } from '../core/sync/edit';
import type { MachinePreset } from '../core/types';
import type { StepId } from './steps';

/** Which face(s) to draw: root, tip or both. */
export type Sides = 'root' | 'tip' | 'both';

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
  sides: Sides;
  rootSide: 'left' | 'right';
  /**
   * Which job page is showing. Each page only offers its own edits: split/pin editing on
   * Segment, LE/TE picks on Transform, plan lines and run-outs on Sequence; the rest is view-only.
   */
  mode: StepId;
  /** Receives edits in cut space (result.sync numbering); the App stores them. */
  onSyncChange: (e: SyncEdit) => void;
  /** Use split k on one profile as its LE or TE (for the twist pivot). */
  onChordPick: (side: Side, end: 'le' | 'te', k: number) => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Menu =
  | { kind: 'split'; k: number; side: Side; sx: number; sy: number }
  | { kind: 'line'; step: number; at: Vec2; sx: number; sy: number }
  | { kind: 'profile'; side: Side; s: number; sx: number; sy: number }
  | { kind: 'pin'; i: number; sx: number; sy: number };

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
  const showR = props.sides !== 'tip';
  const showT = props.sides !== 'root';
  // The root face is driven by the carriage on its side.
  const showLeft = props.rootSide === 'left' ? showR : showT;
  const showRight = props.rootSide === 'left' ? showT : showR;
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const shiftPts = (p: Profile | null) => (p ? p.pts.map((q) => ({ x: q.x + offset.x, y: q.y + offset.y })) : []);
  const rootPts = useMemo(() => (result?.profilePts.root.length ? result.profilePts.root : shiftPts(root)), [result, root, offset]);
  const tipPts = useMemo(() => (result?.profilePts.tip.length ? result.profilePts.tip : shiftPts(tip)), [result, tip, offset]);
  const arcs = result?.arcs ?? null;
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
  // Pressing a split or pin marker: a drag slides it along its profile, a plain click opens its menu.
  const syncDrag = useRef<{ kind: 'split' | 'pin'; side: Side; i: number; x: number; y: number; moved: boolean } | null>(null);

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
  const splitPos = (side: Side, k: number): Vec2 | null => result?.splitPts[side][k] ?? null;
  /** Arc position on a profile nearest to a world point (profiles are drawn shifted by the part offset). */
  const sOnProfile = (side: Side, w: Vec2) => (arcs ? nearestS(arcs[side], w).s : 0);
  const sync = result?.sync ?? null;

  const outAndBackAt = (k: number) => {
    if (!plan || !result) return;
    const outward = (side: 'r' | 't'): { from: Vec2; dir: Vec2 } => {
      const from = splitPos(side === 'r' ? 'root' : 'tip', k)!;
      const corner = result.kerfStations.filter((s) => s.corner && s.seg === k).map((s) => s[side]);
      const avg = corner.reduce((a, p) => add(a, scale(p, 1 / corner.length)), { x: 0, y: 0 });
      let dir = normalize(sub(avg, from));
      if (Math.hypot(dir.x, dir.y) < 0.5) {
        // no kerf: use the profile normal from the neighbouring stations
        const st = result.stations;
        const m = st.length - 1; // closed loop repeats the first station
        const i = st.findIndex((x) => x.boundary && x.seg === k);
        dir = normalize(perpR(sub(st[(i + 1) % m][side], st[(i - 1 + m) % m][side])));
      }
      return { from, dir };
    };
    const r = outward('r');
    const t = outward('t');
    const d = props.outBackDistance;
    onPlanChange(insertOutAndBack(plan, k, { r: add(r.from, scale(r.dir, d)), t: add(t.from, scale(t.dir, d)) }, n));
  };

  const startSyncDrag = (kind: 'split' | 'pin', side: Side, i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    syncDrag.current = { kind, side, i, x: e.clientX, y: e.clientY, moved: false };
    capture(e.pointerId);
  };

  const markers = (side: Side, color: string, dy: number) =>
    result?.splitPts[side].map((p, k) => {
      const x = p.x;
      const y = -p.y;
      return (
        <g key={`${color}-${k}`} className="clickable" onPointerDown={startSyncDrag('split', side, k)}>
          <title>{`Split ${k + 1}: click for options, drag to slide along the profile`}</title>
          <circle cx={x} cy={y} r={unit * 1.2} fill="transparent" />
          <circle cx={x} cy={y} r={unit * (k === 0 ? 0.9 : 0.55)} fill={k === 0 ? color : 'var(--canvas)'} stroke={color} strokeWidth={unit * 0.2} />
          <text x={x + unit * 0.9} y={y + dy * unit} fontSize={unit * 1.6} fill={color}>
            {k === 0 ? `${k + 1} start` : k + 1}
          </text>
        </g>
      );
    });

  const pins = (side: Side, dy: number) =>
    result?.pinPts[side].map((p, i) => {
      const r = unit * 0.75;
      return (
        <g key={`pin-${side}-${i}`} className="clickable" onPointerDown={startSyncDrag('pin', side, i)}>
          <title>{`Pin ${i + 1}: click for options, drag to slide along the profile`}</title>
          <circle cx={p.x} cy={-p.y} r={unit * 1.2} fill="transparent" />
          <rect x={p.x - r / 2} y={-p.y - r / 2} width={r} height={r} transform={`rotate(45 ${p.x} ${-p.y})`} fill="var(--pin)" />
          <text x={p.x + unit * 0.9} y={-p.y + dy * unit} fontSize={unit * 1.4} fill="var(--pin)">
            P{i + 1}
          </text>
        </g>
      );
    });

  /** Thin chord line from LE to TE with a cross at the twist pivot. */
  const chordMarks = (side: Side, color: string) => {
    const c = result!.chord![side];
    const r = unit * 0.6;
    return (
      <g key={`chord-${side}`} stroke={color} opacity={0.7} pointerEvents="none">
        <line x1={c.le.x} y1={-c.le.y} x2={c.te.x} y2={-c.te.y} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" />
        <line x1={c.pivot.x - r} y1={-c.pivot.y - r} x2={c.pivot.x + r} y2={-c.pivot.y + r} vectorEffect="non-scaling-stroke" />
        <line x1={c.pivot.x - r} y1={-c.pivot.y + r} x2={c.pivot.x + r} y2={-c.pivot.y - r} vectorEffect="non-scaling-stroke" />
        <text x={c.le.x} y={-c.le.y + unit * 2.6} fontSize={unit * 1.2} fill={color} stroke="none" textAnchor="middle">LE</text>
        <text x={c.te.x} y={-c.te.y + unit * 2.6} fontSize={unit * 1.2} fill={color} stroke="none" textAnchor="middle">TE</text>
      </g>
    );
  };

  const profileClick = (side: Side, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!arcs) return;
    setMenu({ kind: 'profile', side, s: sOnProfile(side, toWorld(e.clientX, e.clientY)), ...toWrap(e.clientX, e.clientY) });
  };

  const wireLines = (() => {
    const ks = result?.kerfStations ?? [];
    if (!layers.wires || !showR || !showT || ks.length < 2) return [];
    const every = Math.max(1, Math.floor(ks.length / 90));
    return ks.filter((s, i) => i % every === 0 || s.boundary);
  })();

  const edit = {
    sync: props.mode === 'segment',
    chord: props.mode === 'transform',
    plan: props.mode === 'sequence',
  };
  const showMarkers = edit.sync || edit.chord || edit.plan;

  const handles =
    plan && layers.plan && edit.plan
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
              ...(showR ? [h('r', p.r, 'var(--root)')] : []),
              ...(showT ? [h('t', p.t, 'var(--tip)')] : []),
            ];
          return [];
        })
      : [];

  const lastDrawPt = drawing ? (drawing.pts[drawing.pts.length - 1] ?? splitPos('root', drawing.fromSplit)) : null;

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
          const sd = syncDrag.current;
          if (sd) {
            if (!sd.moved && Math.hypot(e.clientX - sd.x, e.clientY - sd.y) < 4) return;
            sd.moved = true;
            if (!sync || !arcs || drawing || !edit.sync) return;
            const sNew = sOnProfile(sd.side, toWorld(e.clientX, e.clientY));
            if (sd.kind === 'split') {
              const ed = moveSplit(sync, plan, arcs, sd.side, sd.i, sNew);
              if (ed) props.onSyncChange(ed);
            } else props.onSyncChange({ sync: movePin(sync, arcs, sd.i, sd.side, sNew), plan });
            return;
          }
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
          const sd = syncDrag.current;
          if (sd) {
            syncDrag.current = null;
            if (sd.moved) return;
            if (sd.kind === 'split' && drawing) finishDrawing(sd.i);
            else if (sd.kind === 'split') setMenu({ kind: 'split', k: sd.i, side: sd.side, ...toWrap(e.clientX, e.clientY) });
            else setMenu({ kind: 'pin', i: sd.i, ...toWrap(e.clientX, e.clientY) });
            return;
          }
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
              {showLeft && <polyline points={pts(carriage.left)} stroke="var(--left)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
              {showRight && <polyline points={pts(carriage.right)} stroke="var(--right)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
            </>
          )}
          {wireLines.map((s, i) => (
            <line key={i} x1={s.r.x} y1={-s.r.y} x2={s.t.x} y2={-s.t.y} stroke="var(--wire)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {layers.profiles && (
            <>
              {showR && <polygon points={pts(rootPts)} stroke="var(--root)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
              {showT && <polygon points={pts(tipPts)} stroke="var(--tip)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
            </>
          )}
          {layers.kerf && result && result.kerfStations.length > 0 && (
            <>
              {showR && <polyline points={pts(result.kerfStations.map((s) => s.r))} stroke="var(--root)" strokeDasharray="5 3" strokeWidth={0.8} opacity={0.6} vectorEffect="non-scaling-stroke" />}
              {showT && <polyline points={pts(result.kerfStations.map((s) => s.t))} stroke="var(--tip)" strokeDasharray="5 3" strokeWidth={0.8} opacity={0.6} vectorEffect="non-scaling-stroke" />}
            </>
          )}
          {layers.plan &&
            runs.map((run, i) => {
              const color = speedColor(run.speed);
              const sel = props.selectedStep === run.step;
              const dash = run.speed === 'cut' ? undefined : '6 4';
              const width = sel ? 3.5 : 2;
              const main = showR ? run.r : run.t;
              const mid = Math.floor((main.length - 1) / 2);
              const arrow = run.speed === 'gap' ? undefined : `url(#arrow-${run.speed})`;
              const clickLine = (e: React.MouseEvent) => {
                e.stopPropagation();
                if (drawing || !edit.plan) return;
                props.onSelectStep(run.step);
                if (run.line && run.step >= 0) setMenu({ kind: 'line', step: run.step, at: toWorld(e.clientX, e.clientY), ...toWrap(e.clientX, e.clientY) });
              };
              return (
                <g key={i}>
                  {showR && showT && <polyline points={pts(run.t)} stroke={color} strokeWidth={width * 0.6} strokeDasharray={dash} opacity={0.55} vectorEffect="non-scaling-stroke" />}
                  <polyline points={pts(main)} stroke={color} strokeWidth={width} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
                  {arrow && main.length >= 2 && <polyline points={pts([main[mid], main[mid + 1]])} stroke="none" markerEnd={arrow} />}
                  {showR && <polyline className="clickable" points={pts(run.r)} stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={clickLine} />}
                  {showT && <polyline className="clickable" points={pts(run.t)} stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={clickLine} />}
                  {run.step >= 0 && run.speed !== 'gap' && (
                    <text x={main[mid].x} y={-main[mid].y - unit * 0.8} fontSize={unit * 1.3} fill={color} stroke="none" textAnchor="middle">
                      {run.step + 1}
                    </text>
                  )}
                </g>
              );
            })}
          {drawing && lastDrawPt && (
            <polyline
              points={pts([splitPos('root', drawing.fromSplit)!, ...drawing.pts, ...(drawing.cursor ? [drawing.cursor] : [])])}
              stroke="var(--cut)"
              strokeDasharray="3 3"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
        {layers.profiles && arcs && !drawing && edit.sync && (
          <g fill="none">
            {showR && (
              <polygon className="clickable" points={pts(rootPts)} stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => profileClick('root', e)}>
                <title>Click to add a split or pin</title>
              </polygon>
            )}
            {showT && (
              <polygon className="clickable" points={pts(tipPts)} stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => profileClick('tip', e)}>
                <title>Click to add a split or pin</title>
              </polygon>
            )}
          </g>
        )}
        {result &&
          showR &&
          showT &&
          result.pinPts.root.map((p, i) => (
            <line key={`pinlink-${i}`} x1={p.x} y1={-p.y} x2={result.pinPts.tip[i].x} y2={-result.pinPts.tip[i].y} stroke="var(--pin)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          ))}
        {result?.chord && edit.chord && showR && chordMarks('root', 'var(--root)')}
        {result?.chord && edit.chord && showT && chordMarks('tip', 'var(--tip)')}
        {result && edit.sync && showR && pins('root', -0.6)}
        {result && edit.sync && showT && pins('tip', 2)}
        {result && showMarkers && showR && markers('root', 'var(--root)', -0.6)}
        {result && showMarkers && showT && markers('tip', 'var(--tip)', 2)}
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
              <div className="popover-title">Split {menu.k + 1} ({menu.side})</div>
              {edit.plan && menuItem('Run out from here…', () => setDrawing({ fromSplit: menu.k, pts: [], cursor: null }))}
              {edit.plan && menuItem(`Out-and-back here (${props.outBackDistance} ${machine.units})`, () => outAndBackAt(menu.k))}
              {edit.sync && sync && menu.k !== 0 && menuItem('Make loop start', () => props.onSyncChange(setLoopStart(sync, plan, menu.k)))}
              {edit.chord && menuItem(`Use as ${menu.side} LE (twist pivot)`, () => props.onChordPick(menu.side, 'le', menu.k))}
              {edit.chord && menuItem(`Use as ${menu.side} TE (twist pivot)`, () => props.onChordPick(menu.side, 'te', menu.k))}
              {edit.sync &&
                sync &&
                sync.root.length > 1 &&
                menuItem('Remove split (both profiles)', () => {
                  const ed = removeSplit(sync, plan, menu.k);
                  if (ed) props.onSyncChange(ed);
                })}
            </>
          ) : menu.kind === 'profile' ? (
            <>
              <div className="popover-title">{menu.side === 'root' ? 'Root' : 'Tip'} profile</div>
              {sync &&
                arcs &&
                menuItem('Add split here (+ matching one on the other profile)', () => {
                  const ed = addSplit(sync, plan, arcs, menu.side, menu.s);
                  if (ed) props.onSyncChange(ed);
                })}
              {sync &&
                arcs &&
                menuItem('Add pin here (+ matching one on the other profile)', () => {
                  const next = addPin(sync, arcs, menu.side, menu.s);
                  if (next) props.onSyncChange({ sync: next, plan });
                })}
            </>
          ) : menu.kind === 'pin' ? (
            <>
              <div className="popover-title">Pin {menu.i + 1}</div>
              {sync && menuItem('Remove pin', () => props.onSyncChange({ sync: removePin(sync, menu.i), plan }))}
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
