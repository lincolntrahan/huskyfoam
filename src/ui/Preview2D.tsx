import { useEffect, useMemo, useRef, useState } from 'react';
import type { CutResult } from '../core/cut/pipeline';
import { nearestS } from '../core/geom/arc';
import type { Profile } from '../core/geom/profile';
import { add, normalize, perpR, scale, sub, type Vec2 } from '../core/geom/vec';
import { insertOutAndBack, insertPointOnLine, insertRunOut, removeStep, reverseStep, setPoint, setSpeed } from '../core/plan/edit';
import type { CutPlan, PlanPoint } from '../core/plan/model';
import type { Rect } from '../core/plan/templates';
import type { PathPt } from '../core/plan/walk';
import { addSplit, movePin, moveSplit, removePin, removeSplit, setLoopStart, setSplitLinked, type Side, type SyncEdit } from '../core/sync/edit';
import { isLinked, locate } from '../core/sync/sync';
import { pairColor } from './DxfPicker';
import { stepPair } from '../core/plan/tree';
import type { Pick } from './PlanPanel';
import type { MachinePreset } from '../core/types';
import type { StepId } from './steps';

/** Which face(s) to draw: root, tip or both. */
export type Sides = 'root' | 'tip' | 'both';

export interface Layers {
  profiles: boolean;
  kerf: boolean;
  plan: boolean;
  carriages: boolean;
}

interface Props {
  /** Every loaded contour of each profile (raw); drawn until the first result exists. */
  root: Profile[];
  tip: Profile[];
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
  onChordPick: (side: Side, end: 'le' | 'te', s: number) => void;
  /** Arrange Profiles: a profile is being dragged by `delta` (world units) from where it was grabbed. */
  onProfileDrag?: (side: Side, phase: 'start' | 'move' | 'end', delta: Vec2) => void;
  /** Sequence Cuts: the pair the templates apply to (click a contour to pick it). */
  selectedPair?: number | null;
  onSelectPair?: (p: number | null) => void;
  /** Sequence Cuts: an insert button is waiting for a split, a segment, or a drawn cut line. */
  pick?: Pick;
  /** Where the wire is at the rollback bar (root face): a new cut line starts here. */
  pickStart?: Vec2;
  onPickSplit?: (k: number) => void;
  onPickSegment?: (seg: number, reversed: boolean) => void;
  onPickLine?: (through: PlanPoint[], endSplit: number | null) => void;
  onCancelPick?: () => void;
  /** Insert at the point a jog ends: moves the rollback bar after that step and starts a pick. */
  onInsertAfter?: (step: number, pick: Pick) => void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Menu =
  | { kind: 'split'; k: number; side: Side; sx: number; sy: number }
  | { kind: 'jognode'; step: number; sx: number; sy: number }
  | { kind: 'line'; step: number; at: Vec2; sx: number; sy: number }
  | { kind: 'profile'; side: Side; pair: number; s: number; sx: number; sy: number }
  | { kind: 'pin'; i: number; side: Side; sx: number; sy: number };

interface Drawing {
  /** Split the run-out leaves from; -1 when drawing a cut line inserted at the rollback bar. */
  fromSplit: number;
  /** Start of a cut line drawn at the bar (where the wire is there). */
  start?: Vec2;
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

/** A contour: polygon when closed, polyline when open. */
function Outline(props: {
  pts: Vec2[];
  closed: boolean;
  stroke: string;
  strokeWidth: number;
  className?: string;
  title?: string;
  onPointerDown?: (e: React.PointerEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const common = {
    points: pts(props.pts),
    stroke: props.stroke,
    strokeWidth: props.strokeWidth,
    className: props.className,
    vectorEffect: 'non-scaling-stroke' as const,
    onPointerDown: props.onPointerDown,
    onClick: props.onClick,
  };
  const title = props.title ? <title>{props.title}</title> : null;
  return props.closed ? <polygon {...common}>{title}</polygon> : <polyline {...common}>{title}</polyline>;
}


export function Preview2D(props: Props) {
  const { root, tip, offset, result, machine, layers, block, plan, onPlanChange } = props;
  const showR = props.sides !== 'tip';
  const showT = props.sides !== 'root';
  // The root face is driven by the carriage on its side.
  const showLeft = props.rootSide === 'left' ? showR : showT;
  const showRight = props.rootSide === 'left' ? showT : showR;
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pairs = result?.pairs ?? [];
  /** Contours to draw per side, as cut once there is a result (else raw, at the part offset). */
  const outlines = useMemo(() => {
    const shift = (list: Profile[]) => list.map((p) => ({ pts: p.pts.map((q) => ({ x: q.x + offset.x, y: q.y + offset.y })), closed: p.closed !== false, pair: -1 }));
    if (!result?.pairs.length) return { root: shift(root), tip: shift(tip) };
    return {
      root: result.pairs.map((pr, i) => ({ pts: pr.pts.root, closed: pr.closed, pair: i })),
      tip: result.pairs.map((pr, i) => ({ pts: pr.pts.tip, closed: pr.closed, pair: i })),
    };
  }, [result, root, tip, offset]);
  const arcs = result?.arcs ?? null;
  const topo = result?.topology ?? result?.stats.segments ?? 0;
  const carriage = useMemo(() => {
    if (!result?.moves.length) return { left: [] as Vec2[], right: [] as Vec2[] };
    const all = [result.start, ...result.moves];
    return { left: all.map((m) => m.left), right: all.map((m) => m.right) };
  }, [result]);
  const runs = useMemo(() => (result ? runsOf(result.path) : []), [result]);

  const content = useMemo(() => {
    const lists = [...outlines.root.map((o) => o.pts), ...outlines.tip.map((o) => o.pts)];
    if (layers.carriages) lists.push(carriage.left, carriage.right);
    if (block.w > 0 && block.h > 0) lists.push([{ x: block.x, y: block.y }, { x: block.x + block.w, y: block.y + block.h }]);
    return boundsOf(lists);
  }, [outlines, carriage, layers.carriages, block]);

  const [view, setView] = useState<Box | null>(null);
  const fitKey = `${root.map((p) => p.pts.length).join(',')}|${tip.map((p) => p.pts.length).join(',')}|${layers.carriages}`;
  useEffect(() => setView(content), [fitKey]); // refit when the geometry or layer set changes
  const vb = view ?? content;

  const [menu, setMenu] = useState<Menu | null>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const pan = useRef<{ x: number; y: number; box: Box; moved: boolean } | null>(null);
  const pointDrag = useRef<{ id: string; role: 'p' | 'r' | 't' } | null>(null);
  // Pressing a split or pin marker: a drag slides it along its profile, a plain click opens its menu.
  const syncDrag = useRef<{ kind: 'split' | 'pin'; side: Side; i: number; x: number; y: number; moved: boolean } | null>(null);
  // Pressing a profile on Arrange Profiles: a drag moves that profile, a plain click opens the LE / TE menu.
  const profileDrag = useRef<{ side: Side; pair: number; x: number; y: number; at: Vec2; moved: boolean } | null>(null);

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
    if (drawing.start) {
      if (free.length || endSplit !== null) props.onPickLine?.(free, endSplit);
      else props.onCancelPick?.();
    } else if (free.length || endSplit !== null) onPlanChange(insertRunOut(plan, drawing.fromSplit, free, endSplit, topo));
    setDrawing(null);
  };
  // "+ Cut line" draws from where the wire is at the rollback bar
  useEffect(() => {
    if (props.pick === 'line') setDrawing({ fromSplit: -1, start: props.pickStart ?? { x: 0, y: 0 }, pts: [], cursor: null });
    else setDrawing((d) => (d?.start ? null : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pick]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawing(null);
        setMenu(null);
        props.onCancelPick?.();
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
  /** Pair and local index of global split k. */
  const splitAt = (k: number) => {
    const p = pairs.findIndex((pr) => k >= pr.split0 && k < pr.split0 + pr.sync.root.length);
    return p < 0 ? null : { p, j: k - pairs[p].split0, pr: pairs[p] };
  };
  /** Pair and local index of global pin i. */
  const pinAt = (i: number) => {
    const p = result?.pinPair[i] ?? -1;
    if (p < 0) return null;
    const before = pairs.slice(0, p).reduce((a, pr) => a + pr.sync.pins.length, 0);
    return { p, j: i - before, pr: pairs[p] };
  };
  const ctxFor = (p: number) => (result?.topology ? { topo: result.topology, pair: p } : undefined);
  const syncEdit = (p: number, ed: SyncEdit | null) => {
    if (ed) props.onSyncChange({ ...ed, pair: p });
  };
  /** Arc position on pair p's contour nearest to a world point. */
  const sOnProfile = (side: Side, w: Vec2, p = 0) => (pairs[p] ? nearestS(pairs[p].arcs[side], w).s : 0);

  const outAndBackAt = (k: number) => {
    if (!plan || !result) return;
    const at = splitAt(k);
    if (!at) return;
    const { pr, j } = at;
    const outward = (side: 'r' | 't'): { from: Vec2; dir: Vec2 } => {
      const from = splitPos(side === 'r' ? 'root' : 'tip', k)!;
      // the kerf corner at this split points to the waste side (an open contour's ends are ambiguous)
      const corner = pr.closed ? pr.kerfStations.filter((s) => s.corner && s.seg === pr.seg0 + j).map((s) => s[side]) : [];
      const avg = corner.reduce((a, p) => add(a, scale(p, 1 / corner.length)), { x: 0, y: 0 });
      let dir = corner.length ? normalize(sub(avg, from)) : { x: 0, y: 0 };
      if (Math.hypot(dir.x, dir.y) < 0.5) {
        // no kerf: use the profile normal at the nearest station, toward the kerf side
        const st = pr.stations;
        let i = 0;
        st.forEach((x, q) => {
          if (Math.hypot(x[side].x - from.x, x[side].y - from.y) < Math.hypot(st[i][side].x - from.x, st[i][side].y - from.y)) i = q;
        });
        const prev = st[Math.max(i - 1, 0)][side];
        const next = st[Math.min(i + 1, st.length - 1)][side];
        dir = normalize(perpR(sub(next, prev)));
        if (pr.offset === 'left') dir = scale(dir, -1);
      }
      return { from, dir };
    };
    const r = outward('r');
    const t = outward('t');
    const d = props.outBackDistance;
    onPlanChange(insertOutAndBack(plan, k, { r: add(r.from, scale(r.dir, d)), t: add(t.from, scale(t.dir, d)) }, topo));
  };

  const startSyncDrag = (kind: 'split' | 'pin', side: Side, i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    syncDrag.current = { kind, side, i, x: e.clientX, y: e.clientY, moved: false };
    capture(e.pointerId);
  };

  const markers = (side: Side, color: string) =>
    result?.splitPts[side].map((p, k) => {
      const x = p.x;
      const y = -p.y;
      const at = splitAt(k);
      // each contour's first split is its start
      const first = at?.j === 0;
      const linked = at ? isLinked(at.pr.sync, at.j) : true;
      return (
        <g key={`${color}-${k}`} className="clickable" onPointerDown={startSyncDrag('split', side, k)}>
          <title>{`Split ${k + 1}${linked ? '' : ' (unlinked: moves on this profile only)'}: click for options, drag to slide along the profile`}</title>
          <circle cx={x} cy={y} r={unit * 0.8} fill="transparent" />
          <circle cx={x} cy={y} r={unit * (first ? 0.27 : 0.17)} fill={first ? color : 'var(--canvas)'} stroke={color} strokeWidth={unit * 0.07} />
          {/* a dashed ring marks a split that no longer follows its partner */}
          {!linked && <circle cx={x} cy={y} r={unit * 0.45} fill="none" stroke={color} strokeWidth={unit * 0.06} strokeDasharray={`${unit * 0.15} ${unit * 0.1}`} />}
        </g>
      );
    });

  const pins = (side: Side) =>
    result?.pinPts[side].map((p, i) => {
      const r = unit * 0.3;
      return (
        <g key={`pin-${side}-${i}`} className="clickable" onPointerDown={startSyncDrag('pin', side, i)}>
          <title>{`Pin ${i + 1}: click for options, drag to slide along the profile`}</title>
          <circle cx={p.x} cy={-p.y} r={unit * 0.8} fill="transparent" />
          <rect x={p.x - r / 2} y={-p.y - r / 2} width={r} height={r} transform={`rotate(45 ${p.x} ${-p.y})`} fill="var(--pin)" />
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
      </g>
    );
  };

  /** Sequence Cuts: a click on a contour picks its pair, selects the step cutting that segment, or adds the segment. */
  const planOutlineClick = (side: Side, pair: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const pr = pairs[pair];
    if (!pr || !plan) return;
    const at = locate(pr.arcs[side], pr.sync[side], sOnProfile(side, toWorld(e.clientX, e.clientY), pair));
    const seg = at ? pr.seg0 + at.k : null;
    if (props.pick === 'segment') {
      if (seg !== null) props.onPickSegment?.(seg, false);
      return;
    }
    props.onSelectPair?.(pair);
    const step = seg === null ? -1 : plan.steps.findIndex((s) => s.kind === 'segment' && s.seg === seg);
    props.onSelectStep(step >= 0 ? step : null);
  };

  const profileClick = (side: Side, pair: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pairs[pair]) return;
    setMenu({ kind: 'profile', side, pair, s: sOnProfile(side, toWorld(e.clientX, e.clientY), pair), ...toWrap(e.clientX, e.clientY) });
  };


  // Sequence Cuts draws each contour pair in its pair colour
  const byPair = props.mode === 'sequence';
  // cut paths take their pair's colour (white when not tied to one); jogs are dashed
  const runColors = [...pairs.map((_, i) => pairColor(i, 'var(--root)')), 'var(--text)'];
  const runColorIndex = (step: number) => {
    const p = plan && topo ? stepPair(plan, topo, step) : -1;
    return p < 0 ? runColors.length - 1 : p;
  };
  const runColor = (run: { step: number; speed: PathPt['speed'] }) => (run.speed === 'gap' ? 'var(--err)' : runColors[runColorIndex(run.step)]);
  const edit = {
    sync: props.mode === 'segment',
    chord: props.mode === 'transform',
    plan: props.mode === 'sequence',
  };
  // split markers belong to the outlines (hidden with them) and only matter once you segment
  const showMarkers = layers.profiles && (edit.sync || edit.plan);

  // ---- labels: collected here, then placed so they never overlap (lower prio wins a spot first)
  interface Label {
    key: string;
    x: number;
    y: number; // svg coordinates (y down)
    text: string;
    color: string;
    prio: number;
  }
  const labels: Label[] = [];
  if (result && showMarkers) {
    (['root', 'tip'] as Side[]).forEach((side) => {
      if (side === 'root' ? !showR : !showT) return;
      const color = side === 'root' ? 'var(--root)' : 'var(--tip)';
      result.splitPts[side].forEach((p, k) => labels.push({ key: `s-${side}-${k}`, x: p.x, y: -p.y, text: splitAt(k)?.j === 0 ? `${k + 1} start` : String(k + 1), color, prio: splitAt(k)?.j === 0 ? 0 : 2 }));
      if (edit.sync) result.pinPts[side].forEach((p, i) => labels.push({ key: `p-${side}-${i}`, x: p.x, y: -p.y, text: `P${i + 1}`, color: 'var(--pin)', prio: 1 }));
    });
  }
  if (result?.chord && edit.chord && layers.profiles) {
    (['root', 'tip'] as Side[]).forEach((side) => {
      if (side === 'root' ? !showR : !showT) return;
      const c = result.chord![side];
      const color = side === 'root' ? 'var(--root)' : 'var(--tip)';
      labels.push({ key: `le-${side}`, x: c.le.x, y: -c.le.y, text: 'LE', color, prio: 0 }, { key: `te-${side}`, x: c.te.x, y: -c.te.y, text: 'TE', color, prio: 0 });
    });
  }
  if (layers.plan) {
    for (const run of runs) {
      if (run.step < 0 || run.speed === 'gap') continue;
      const main = showR ? run.r : run.t;
      const m = main[Math.floor((main.length - 1) / 2)];
      labels.push({ key: `r-${run.step}-${run.speed}`, x: m.x, y: -m.y, text: String(run.step + 1), color: runColor(run), prio: 3 });
    }
  }
  const fontSize = unit * 1.2;
  const placed = (() => {
    const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const out: (Label & { tx: number; ty: number })[] = [];
    const pad = fontSize * 0.15;
    for (const l of [...labels].sort((a, b) => a.prio - b.prio)) {
      const w = l.text.length * fontSize * 0.6;
      // try: right-above, right-below, left-above, left-below of the point
      const tries = [
        [fontSize * 0.5, -fontSize * 0.35],
        [fontSize * 0.5, fontSize * 1.05],
        [-w - fontSize * 0.5, -fontSize * 0.35],
        [-w - fontSize * 0.5, fontSize * 1.05],
      ];
      for (const [dx, dy] of tries) {
        const b = { x0: l.x + dx - pad, y0: l.y + dy - fontSize - pad, x1: l.x + dx + w + pad, y1: l.y + dy + pad };
        if (boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
        boxes.push(b);
        out.push({ ...l, tx: l.x + dx, ty: l.y + dy });
        break;
      }
    }
    return out;
  })();

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

  const drawStart = drawing ? (drawing.start ?? splitPos('root', drawing.fromSplit)) : null;
  const lastDrawPt = drawing ? (drawing.pts[drawing.pts.length - 1] ?? drawStart) : null;

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
          const prd = profileDrag.current;
          if (prd) {
            if (!prd.moved && Math.hypot(e.clientX - prd.x, e.clientY - prd.y) < 4) return;
            if (!prd.moved) props.onProfileDrag?.(prd.side, 'start', { x: 0, y: 0 });
            prd.moved = true;
            const w = toWorld(e.clientX, e.clientY);
            props.onProfileDrag?.(prd.side, 'move', sub(w, prd.at));
            return;
          }
          const sd = syncDrag.current;
          if (sd) {
            if (!sd.moved && Math.hypot(e.clientX - sd.x, e.clientY - sd.y) < 4) return;
            sd.moved = true;
            if (drawing || !edit.sync) return;
            const at = sd.kind === 'split' ? splitAt(sd.i) : pinAt(sd.i);
            if (!at) return;
            const sNew = sOnProfile(sd.side, toWorld(e.clientX, e.clientY), at.p);
            if (sd.kind === 'split') syncEdit(at.p, moveSplit(at.pr.sync, plan, at.pr.arcs, sd.side, at.j, sNew));
            else syncEdit(at.p, { sync: movePin(at.pr.sync, at.pr.arcs, at.j, sd.side, sNew), plan });
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
          const prd = profileDrag.current;
          if (prd) {
            profileDrag.current = null;
            if (prd.moved) props.onProfileDrag?.(prd.side, 'end', sub(toWorld(e.clientX, e.clientY), prd.at));
            // LE / TE picks are on the outer contour only
            else if (prd.pair === 0) setMenu({ kind: 'profile', side: prd.side, pair: 0, s: sOnProfile(prd.side, toWorld(e.clientX, e.clientY), 0), ...toWrap(e.clientX, e.clientY) });
            return;
          }
          const sd = syncDrag.current;
          if (sd) {
            syncDrag.current = null;
            if (sd.moved) return;
            if (sd.kind === 'split' && props.pick === 'jog') props.onPickSplit?.(sd.i);
            else if (sd.kind === 'split' && drawing) finishDrawing(sd.i);
            else if (sd.kind === 'split') setMenu({ kind: 'split', k: sd.i, side: sd.side, ...toWrap(e.clientX, e.clientY) });
            else setMenu({ kind: 'pin', i: sd.i, side: sd.side, ...toWrap(e.clientX, e.clientY) });
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
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={unit * 0.35} result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {runColors.map((c, i) => (
            <marker key={i} id={`arrow-${i}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth={unit * 0.5} markerHeight={unit * 0.5} orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L10,5 L0,10 z" fill={c} />
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
              {showLeft && <polyline points={pts(carriage.left)} stroke={props.rootSide === 'left' ? 'var(--rootcar)' : 'var(--tipcar)'} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
              {showRight && <polyline points={pts(carriage.right)} stroke={props.rootSide === 'left' ? 'var(--tipcar)' : 'var(--rootcar)'} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
            </>
          )}
          {layers.profiles && (
            <>
              {showR &&
                outlines.root.map((o, i) => (
                  <Outline key={`r${i}`} pts={o.pts} closed={o.closed} stroke={byPair ? pairColor(o.pair, 'var(--root)') : 'var(--root)'} strokeWidth={byPair && o.pair === props.selectedPair ? 3.5 : 1.5} />
                ))}
              {showT &&
                outlines.tip.map((o, i) => (
                  <g key={`t${i}`} opacity={byPair ? 0.55 : 1}>
                    <Outline pts={o.pts} closed={o.closed} stroke={byPair ? pairColor(o.pair, 'var(--tip)') : 'var(--tip)'} strokeWidth={byPair && o.pair === props.selectedPair ? 3.5 : 1.5} />
                  </g>
                ))}
            </>
          )}
          {layers.kerf &&
            pairs.map((pr, i) =>
              pr.kerfStations.length > 0 ? (
                <g key={`kerf${i}`}>
                  {showR && <polyline points={pts(pr.kerfStations.map((s) => s.r))} stroke="var(--root)" strokeDasharray="5 3" strokeWidth={0.8} opacity={0.6} vectorEffect="non-scaling-stroke" />}
                  {showT && <polyline points={pts(pr.kerfStations.map((s) => s.t))} stroke="var(--tip)" strokeDasharray="5 3" strokeWidth={0.8} opacity={0.6} vectorEffect="non-scaling-stroke" />}
                </g>
              ) : null,
            )}
          {/* Sequence Cuts: click a contour to pick its pair (or, adding a segment, the segment); below the cut paths */}
          {edit.plan && layers.profiles && !drawing &&
            (['root', 'tip'] as Side[]).map((side) =>
              (side === 'root' ? showR : showT)
                ? pairs.map((pr, i) => (
                    <Outline
                      key={`seqhit-${side}-${i}`}
                      className="clickable"
                      pts={pr.pts[side]}
                      closed={pr.closed}
                      stroke="transparent"
                      strokeWidth={12}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => planOutlineClick(side, i, e)}
                      title={props.pick === 'segment' ? 'Click to add this segment' : `Pair ${i + 1}: click to pick it for a template`}
                    />
                  ))
                : null,
            )}
          {layers.plan &&
            runs.map((run, i) => {
              const color = runColor(run);
              const sel = props.selectedStep === run.step;
              const dimmed = props.selectedStep !== null && !sel;
              const dash = run.speed === 'cut' ? undefined : '6 4';
              const width = sel ? 5 : 2;
              const main = showR ? run.r : run.t;
              const mid = Math.floor((main.length - 1) / 2);
              const arrow = run.speed === 'gap' ? undefined : `url(#arrow-${runColorIndex(run.step)})`;
              const clickLine = (e: React.MouseEvent) => {
                e.stopPropagation();
                if (drawing || !edit.plan) return;
                props.onSelectStep(run.step);
                if (run.line && run.step >= 0) setMenu({ kind: 'line', step: run.step, at: toWorld(e.clientX, e.clientY), ...toWrap(e.clientX, e.clientY) });
              };
              return (
                <g key={i} opacity={dimmed ? 0.22 : 1} filter={sel ? 'url(#glow)' : undefined}>
                  {showR && showT && <polyline points={pts(run.t)} stroke={color} strokeWidth={width * 0.6} strokeDasharray={dash} opacity={0.55} vectorEffect="non-scaling-stroke" />}
                  {sel && <polyline points={pts(main)} stroke="#ffffff" strokeWidth={width + 4} opacity={0.35} vectorEffect="non-scaling-stroke" />}
                  <polyline points={pts(main)} stroke={color} strokeWidth={width} strokeDasharray={dash} vectorEffect="non-scaling-stroke" />
                  {arrow && main.length >= 2 && <polyline points={pts([main[mid], main[mid + 1]])} stroke="none" markerEnd={arrow} />}
                  {showR && <polyline className="clickable" points={pts(run.r)} stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={clickLine} />}
                  {showT && <polyline className="clickable" points={pts(run.t)} stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={clickLine} />}
                </g>
              );
            })}
          {/* jog nodes: click where a jog ends to insert after it */}
          {edit.plan &&
            layers.plan &&
            !drawing &&
            runs
              .filter((run) => run.speed === 'jog' && run.step >= 0)
              .map((run) => {
                const main = showR ? run.r : run.t;
                const end = main[main.length - 1];
                return (
                  <circle
                    key={`jn-${run.step}`}
                    className="clickable"
                    cx={end.x}
                    cy={-end.y}
                    r={unit * 0.35}
                    fill="var(--canvas)"
                    stroke={runColor(run)}
                    strokeWidth={unit * 0.12}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onSelectStep(run.step);
                      setMenu({ kind: 'jognode', step: run.step, ...toWrap(e.clientX, e.clientY) });
                    }}
                  >
                    <title>{`End of jog (step ${run.step + 1}): click to add a segment, jog or cut line after it`}</title>
                  </circle>
                );
              })}
          {drawing && lastDrawPt && (
            <polyline
              points={pts([drawStart!, ...drawing.pts, ...(drawing.cursor ? [drawing.cursor] : [])])}
              stroke="var(--cut)"
              strokeDasharray="3 3"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
        {layers.profiles && arcs && !drawing && (edit.sync || edit.chord) && (
          <g fill="none">
            {(['root', 'tip'] as Side[]).map((side) =>
              (side === 'root' ? showR : showT)
                ? pairs.map((pr, i) => (
                    <Outline
                      key={`hit-${side}-${i}`}
                      className={edit.chord ? 'grab' : 'clickable'}
                      pts={pr.pts[side]}
                      closed={pr.closed}
                      stroke="transparent"
                      strokeWidth={10}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (!edit.chord) return;
                        profileDrag.current = { side, pair: i, x: e.clientX, y: e.clientY, at: toWorld(e.clientX, e.clientY), moved: false };
                        capture(e.pointerId);
                      }}
                      onClick={edit.chord ? undefined : (e) => profileClick(side, i, e)}
                      title={
                        edit.chord
                          ? `Drag to move the ${side} relative to the ${side === 'root' ? 'tip' : 'root'}${i === 0 ? '; click to set its LE or TE here' : ''}`
                          : 'Click to add a split or pin'
                      }
                    />
                  ))
                : null,
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
        {result && showMarkers && edit.sync && showR && pins('root')}
        {result && showMarkers && edit.sync && showT && pins('tip')}
        {result && showMarkers && showR && markers('root', 'var(--root)')}
        {result && showMarkers && showT && markers('tip', 'var(--tip)')}
        <g pointerEvents="none" className="labels">
          {placed.map((l) => (
            <text key={l.key} x={l.tx} y={l.ty} fontSize={fontSize} fill={l.color}>
              {l.text}
            </text>
          ))}
        </g>
        {handles}
      </svg>

      {drawing && (
        <div className="banner">
          {drawing.start
            ? 'Drawing a cut line from where the wire is at the rollback bar: click to add points, click a split marker to end there, Enter or double-click to stop, Esc to cancel.'
            : `Drawing a run-out from split ${drawing.fromSplit + 1}: click to add points, click a split marker to run back in, Enter or double-click to stop here, Esc to cancel.`}
        </div>
      )}
      {props.pick === 'jog' && <div className="banner">Click a split marker to jog to it (over the block). Esc to cancel.</div>}
      {props.pick === 'segment' && <div className="banner">Click a profile segment to add it, forward. Esc to cancel.</div>}

      {menu && plan && (
        <div className="popover" style={{ left: menu.sx, top: menu.sy }} onPointerDown={(e) => e.stopPropagation()}>
          {menu.kind === 'split' ? (
            <>
              <div className="popover-title">Split {menu.k + 1} ({menu.side})</div>
              {edit.plan && menuItem('Run out from here…', () => setDrawing({ fromSplit: menu.k, pts: [], cursor: null }))}
              {edit.plan && menuItem(`Out-and-back here (${props.outBackDistance} ${machine.units})`, () => outAndBackAt(menu.k))}
              {edit.sync &&
                (() => {
                  const at = splitAt(menu.k);
                  if (!at) return null;
                  const { p, j, pr } = at;
                  const linked = isLinked(pr.sync, j);
                  const end = !pr.closed && (j === 0 || j === pr.sync.root.length - 1);
                  return (
                    <>
                      {!end &&
                        menuItem(linked ? 'Unlink (move on this profile only)' : 'Link again (snaps the other profile to match)', () =>
                          syncEdit(p, { sync: setSplitLinked(pr.sync, pr.arcs, menu.side, j, !linked), plan }),
                        )}
                      {pr.closed && j !== 0 && menuItem('Make contour start', () => syncEdit(p, setLoopStart(pr.sync, plan, j, ctxFor(p))))}
                      {!end && pr.sync.root.length > 1 && menuItem('Remove split (both profiles)', () => syncEdit(p, removeSplit(pr.sync, plan, j, ctxFor(p), pr.arcs)))}
                    </>
                  );
                })()}
            </>
          ) : menu.kind === 'profile' ? (
            <>
              <div className="popover-title">
                {menu.side === 'root' ? 'Root' : 'Tip'} {pairs.length > 1 ? `contour ${(pairs[menu.pair]?.[menu.side] ?? 0) + 1}` : 'profile'}
              </div>
              {edit.chord && menuItem(`Use as ${menu.side} LE here (twist pivot)`, () => props.onChordPick(menu.side, 'le', menu.s))}
              {edit.chord && menuItem(`Use as ${menu.side} TE here (twist pivot)`, () => props.onChordPick(menu.side, 'te', menu.s))}
              {edit.sync &&
                pairs[menu.pair] &&
                menuItem('Add split here (+ matching one on the other profile)', () => {
                  const pr = pairs[menu.pair];
                  syncEdit(menu.pair, addSplit(pr.sync, plan, pr.arcs, menu.side, menu.s, ctxFor(menu.pair)));
                })}
            </>
          ) : menu.kind === 'jognode' ? (
            <>
              <div className="popover-title">After step {menu.step + 1} (jog)</div>
              {menuItem('+ Segment here…', () => props.onInsertAfter?.(menu.step, 'segment'))}
              {menuItem('+ Cut line from here…', () => props.onInsertAfter?.(menu.step, 'line'))}
              {menuItem('+ Jog to a split…', () => props.onInsertAfter?.(menu.step, 'jog'))}
            </>
          ) : menu.kind === 'pin' ? (
            <>
              <div className="popover-title">Pin {menu.i + 1} (from an older project)</div>
              {(() => {
                const at = pinAt(menu.i);
                if (!at) return null;
                const { p, j, pr } = at;
                return menuItem('Remove pin', () => syncEdit(p, { sync: removePin(pr.sync, j), plan }));
              })()}
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
