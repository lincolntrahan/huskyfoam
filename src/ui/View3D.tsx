import { Html, Line, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { profilePlanes, type CutResult } from '../core/cut/pipeline';
import type { Vec2 } from '../core/geom/vec';
import { buildTimeline, stateAt } from '../core/sim/timeline';
import type { JobSettings, MachinePreset } from '../core/types';
import type { StepId } from './steps';

/**
 * 3D view of the job: machine (carriage planes + travel), foam block, profiles on their planes,
 * the surface the wire sweeps through the block, the wire itself and both carriage paths, with
 * playback. Machine X/Y are X/Y here; Z runs along the wire from the left carriage (0) to the
 * right one (carriage spacing).
 */

export interface Filters3D {
  machine: boolean;
  block: boolean;
  profiles: boolean;
  surface: boolean;
  wire: boolean;
  carriages: boolean;
}

const FILTER_LABELS: [keyof Filters3D, string][] = [
  ['machine', 'Machine'],
  ['block', 'Foam block'],
  ['profiles', 'Profiles'],
  ['surface', 'Cut surface'],
  ['wire', 'Wire'],
  ['carriages', 'Carriage paths'],
];

const SPEEDS = [1, 5, 20, 100];

/** What each job page shows in 3D (the Import page has no 3D view). */
function allowedFor(mode: StepId): Filters3D {
  const cut = mode === 'preview' || mode === 'export';
  const profiles = cut || mode === 'transform' || mode === 'setup' || mode === 'segment' || mode === 'sequence';
  return { machine: true, block: true, profiles, surface: cut, wire: cut, carriages: cut };
}

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const v3 = (p: Vec2, z: number) => new THREE.Vector3(p.x, p.y, z);

function fmt(min: number) {
  const s = Math.max(0, Math.round(min * 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface SceneProps {
  result: CutResult;
  job: JobSettings;
  machine: MachinePreset;
  filters: Filters3D;
  time: number;
  playing: boolean;
  speed: number;
  onTime: (t: number) => void;
  total: number;
  /** Show where to set the block (Export). */
  dims?: boolean;
}

/**
 * Where to set the block, as dimension lines along its bottom front edge: left carriage to the
 * block's left face, right carriage to its right face, and X = 0 to its front face.
 */
function BlockDims({ job, machine, D, color }: { job: JobSettings; machine: MachinePreset; D: number; color: string }) {
  const b = job.block;
  const za = Math.min(job.rootFaceFromLeft, job.rootFaceFromLeft + job.span);
  const zb = Math.max(job.rootFaceFromLeft, job.rootFaceFromLeft + job.span);
  const x0 = machine.travel.x[0];
  const y = b.y;
  const u = machine.units;
  const tick = Math.max(b.h, 0.5) * 0.35;
  const fmt = (v: number) => `${(Math.round(v * 1000) / 1000).toFixed(3)} ${u}`;
  const V = (x: number, yy: number, z: number) => new THREE.Vector3(x, yy, z);
  /** A dimension: the line, a tick at each end, and a label in the middle. */
  const dim = (key: string, a: THREE.Vector3, c: THREE.Vector3, label: string) => (
    <group key={key}>
      <Line points={[a, c]} color={color} lineWidth={2} />
      <Line points={[V(a.x, a.y - tick / 2, a.z), V(a.x, a.y + tick / 2, a.z)]} color={color} lineWidth={2} />
      <Line points={[V(c.x, c.y - tick / 2, c.z), V(c.x, c.y + tick / 2, c.z)]} color={color} lineWidth={2} />
      <Html position={a.clone().add(c).multiplyScalar(0.5)} center zIndexRange={[10, 0]}>
        <div className="dim3d">{label}</div>
      </Html>
    </group>
  );
  return (
    <group>
      {dim('left', V(b.x, y, 0), V(b.x, y, za), `Left carriage → block: ${fmt(za)}`)}
      {dim('right', V(b.x, y, zb), V(b.x, y, D), `Block → right carriage: ${fmt(D - zb)}`)}
      {dim('front', V(x0, y, (za + zb) / 2), V(b.x, y, (za + zb) / 2), `X = ${x0} → block front: ${fmt(b.x - x0)}`)}
    </group>
  );
}

function Scene({ result, job, machine, filters, time, playing, speed, onTime, total, dims }: SceneProps) {
  const D = machine.carriageSpacing;
  const colors = useMemo(
    () => ({
      root: cssColor('--root', '#2f7bff'),
      tip: cssColor('--tip', '#ff2d2d'),
      rootcar: cssColor('--rootcar', '#00e65c'),
      tipcar: cssColor('--tipcar', '#b84dff'),
      cut: cssColor('--cut', '#ffd400'),
      muted: cssColor('--muted', '#b4b4bc'),
      text: cssColor('--text', '#ffffff'),
      block: cssColor('--block-edge', '#ff9100'),
    }),
    [],
  );
  const { zr, zt } = profilePlanes(job);
  // the root-side carriage is green, the tip-side one purple
  const leftColor = job.rootSide === 'left' ? colors.rootcar : colors.tipcar;
  const rightColor = job.rootSide === 'left' ? colors.tipcar : colors.rootcar;
  // block faces along the wire
  const zb0 = job.rootFaceFromLeft;
  const zb1 = job.rootFaceFromLeft + job.span;
  const hasBlock = job.block.w > 0 && job.block.h > 0;

  // advance playback
  const timeRef = useRef(time);
  timeRef.current = time;
  useFrame((_, delta) => {
    if (!playing) return;
    const t = Math.min(total, timeRef.current + (delta * speed) / 60);
    onTime(t);
  });

  const timeline = useMemo(() => buildTimeline(result.moves), [result.moves]);
  const sim = stateAt(result.start, result.moves, timeline, time);

  // Swept surface between the block faces (or the profile planes if no block): one quad per cut move.
  const surface = useMemo(() => {
    const za = hasBlock ? Math.min(zb0, zb1) : Math.min(zr, zt);
    const zb = hasBlock ? Math.max(zb0, zb1) : Math.max(zr, zt);
    const at = (c: { left: Vec2; right: Vec2 }, z: number) =>
      new THREE.Vector3(c.left.x + ((c.right.x - c.left.x) * z) / D, c.left.y + ((c.right.y - c.left.y) * z) / D, z);
    const verts: number[] = [];
    const quadEnd: number[] = []; // vertex count after each move
    let prev = result.start;
    for (const m of result.moves) {
      if (m.speed !== 'jog') {
        const a0 = at(prev, za), a1 = at(prev, zb), b0 = at(m, za), b1 = at(m, zb);
        verts.push(a0.x, a0.y, a0.z, a1.x, a1.y, a1.z, b1.x, b1.y, b1.z, a0.x, a0.y, a0.z, b1.x, b1.y, b1.z, b0.x, b0.y, b0.z);
      }
      quadEnd.push(verts.length / 3);
      prev = m;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    return { g, quadEnd };
  }, [result, D, hasBlock, zb0, zb1, zr, zt]);
  useEffect(() => () => surface.g.dispose(), [surface]);
  surface.g.setDrawRange(0, sim.done > 0 ? surface.quadEnd[sim.done - 1] : 0);

  const carriagePath = useMemo(() => {
    const all = [result.start, ...result.moves];
    return { left: all.map((c) => v3(c.left, 0)), right: all.map((c) => v3(c.right, D)) };
  }, [result, D]);
  // carriage paths up to the current time
  const shown = (list: THREE.Vector3[], side: 'left' | 'right') => {
    const upto = list.slice(0, sim.done + 1);
    upto.push(v3(sim[side], side === 'left' ? 0 : D));
    return upto.length >= 2 ? upto : null;
  };

  const [tx0, tx1] = machine.travel.x;
  const [ty0, ty1] = machine.travel.y;
  const frame = (z: number) => [new THREE.Vector3(tx0, ty0, z), new THREE.Vector3(tx1, ty0, z), new THREE.Vector3(tx1, ty1, z), new THREE.Vector3(tx0, ty1, z), new THREE.Vector3(tx0, ty0, z)];
  const leftPath = filters.carriages ? shown(carriagePath.left, 'left') : null;
  const rightPath = filters.carriages ? shown(carriagePath.right, 'right') : null;

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[tx1, ty1 * 2, D * 1.5]} intensity={0.9} />
      <directionalLight position={[tx0, ty1, -D]} intensity={0.4} />

      {filters.machine && (
        <group>
          <Line points={frame(0)} color={leftColor} lineWidth={1} />
          <Line points={frame(D)} color={rightColor} lineWidth={1} />
          {[
            [tx0, ty0],
            [tx1, ty0],
          ].map(([x, y], i) => (
            <Line key={i} points={[new THREE.Vector3(x, y, 0), new THREE.Vector3(x, y, D)]} color={colors.muted} lineWidth={1} dashed dashSize={1} gapSize={0.6} />
          ))}
        </group>
      )}

      {filters.block && hasBlock && (
        <mesh position={[job.block.x + job.block.w / 2, job.block.y + job.block.h / 2, (zb0 + zb1) / 2]}>
          <boxGeometry args={[job.block.w, job.block.h, Math.abs(zb1 - zb0)]} />
          <meshStandardMaterial color={colors.block} transparent opacity={0.12} depthWrite={false} />
        </mesh>
      )}
      {dims && filters.block && hasBlock && <BlockDims job={job} machine={machine} D={D} color={colors.text} />}
      {filters.block && hasBlock && (
        <lineSegments position={[job.block.x + job.block.w / 2, job.block.y + job.block.h / 2, (zb0 + zb1) / 2]}>
          <edgesGeometry args={[new THREE.BoxGeometry(job.block.w, job.block.h, Math.abs(zb1 - zb0))]} />
          <lineBasicMaterial color={colors.block} />
        </lineSegments>
      )}

      {filters.profiles &&
        result.pairs.map((pr, i) =>
          pr.pts.root.length > 1 ? (
            <group key={i}>
              <Line points={(pr.closed ? [...pr.pts.root, pr.pts.root[0]] : pr.pts.root).map((p) => v3(p, zr))} color={colors.root} lineWidth={2} />
              <Line points={(pr.closed ? [...pr.pts.tip, pr.pts.tip[0]] : pr.pts.tip).map((p) => v3(p, zt))} color={colors.tip} lineWidth={2} />
            </group>
          ) : null,
        )}

      {filters.surface && (
        <mesh geometry={surface.g}>
          <meshStandardMaterial color={colors.cut} side={THREE.DoubleSide} transparent opacity={0.55} roughness={0.8} />
        </mesh>
      )}

      {leftPath && <Line points={leftPath} color={leftColor} lineWidth={1.5} />}
      {rightPath && <Line points={rightPath} color={rightColor} lineWidth={1.5} />}

      {filters.wire && (
        <group>
          <Line points={[v3(sim.left, 0), v3(sim.right, D)]} color={colors.cut} lineWidth={3} />
          <mesh position={v3(sim.left, 0)}>
            <sphereGeometry args={[D * 0.006, 16, 16]} />
            <meshStandardMaterial color={leftColor} />
          </mesh>
          <mesh position={v3(sim.right, D)}>
            <sphereGeometry args={[D * 0.006, 16, 16]} />
            <meshStandardMaterial color={rightColor} />
          </mesh>
        </group>
      )}
    </>
  );
}

export default function View3D(props: { result: CutResult | null; job: JobSettings; machine: MachinePreset; mode: StepId }) {
  const { result, job, machine } = props;
  const [chosen, setFilters] = useState<Filters3D>({ machine: true, block: true, profiles: true, surface: true, wire: true, carriages: true });
  const allowed = allowedFor(props.mode);
  const filters = Object.fromEntries((Object.keys(chosen) as (keyof Filters3D)[]).map((k) => [k, chosen[k] && allowed[k]])) as unknown as Filters3D;
  const canPlay = props.mode === 'preview' || props.mode === 'export';
  const timeline = useMemo(() => (result ? buildTimeline(result.moves) : null), [result]);
  const total = timeline?.total ?? 0;
  const [time, setTime] = useState(total);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(20);
  // when the job changes, show the finished cut
  useEffect(() => {
    setTime(total);
    setPlaying(false);
  }, [total]);
  useEffect(() => {
    if (playing && time >= total) setPlaying(false);
  }, [playing, time, total]);
  // pages without playback always show the finished state
  useEffect(() => {
    if (!canPlay) {
      setPlaying(false);
      setTime(total);
    }
  }, [canPlay, total]);

  if (!result) {
    return (
      <div className="canvas-wrap">
        <div className="empty">Load both profiles to see the job in 3D.</div>
      </div>
    );
  }

  const D = machine.carriageSpacing;
  const [tx0, tx1] = machine.travel.x;
  const [ty0, ty1] = machine.travel.y;
  // frame the part (block outline, or the profiles), not the whole travel envelope
  const hasBlock = job.block.w > 0 && job.block.h > 0;
  const ppts = [...result.profilePts.root, ...result.profilePts.tip];
  const bx0 = hasBlock ? job.block.x : Math.min(...ppts.map((p) => p.x), tx0);
  const bx1 = hasBlock ? job.block.x + job.block.w : Math.max(...ppts.map((p) => p.x), tx1);
  const by0 = hasBlock ? job.block.y : Math.min(...ppts.map((p) => p.y), ty0);
  const by1 = hasBlock ? job.block.y + job.block.h : Math.max(...ppts.map((p) => p.y), ty1);
  const center: [number, number, number] = [(bx0 + bx1) / 2, (by0 + by1) / 2, D / 2];
  const size = Math.max(bx1 - bx0, by1 - by0, D * 0.55);

  return (
    <div className="canvas-wrap view3d">
      <Canvas camera={{ position: [center[0] + size * 0.75, center[1] + size * 0.55, center[2] - size * 1.0], fov: 40, near: size / 1000, far: size * 50 }}>
        <Scene
          result={result}
          job={job}
          machine={machine}
          filters={filters}
          time={canPlay ? time : total}
          playing={canPlay && playing}
          speed={speed}
          onTime={setTime}
          total={total}
          dims={props.mode === 'export'}
        />
        <OrbitControls makeDefault target={center} />
      </Canvas>

      <div className="layers">
        {FILTER_LABELS.filter(([k]) => allowed[k]).map(([k, label]) => (
          <label key={k}>
            <input type="checkbox" checked={chosen[k]} onChange={(e) => setFilters({ ...chosen, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
      </div>

      {canPlay && (
      <div className="playback">
        <button
          className="primary"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (!playing && time >= total) setTime(0);
            setPlaying(!playing);
          }}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button onClick={() => { setPlaying(false); setTime(0); }} aria-label="Back to start" title="Back to start">
          ⏮
        </button>
        <input
          type="range"
          min={0}
          max={total}
          step={total / 1000 || 1}
          value={time}
          aria-label="Playback position"
          onChange={(e) => {
            setPlaying(false);
            setTime(parseFloat(e.target.value));
          }}
        />
        <span className="time">
          {fmt(time)} / {fmt(total)}
        </span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
      )}
      <div className={canPlay ? 'hint3d' : 'hint3d low'}>Drag to orbit · right-drag to pan · scroll to zoom</div>
    </div>
  );
}
