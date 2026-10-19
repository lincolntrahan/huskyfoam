# HuskyFoam — Spec & Architecture

A browser app that replaces DevFoam's "Cut a new Tapered Part" workflow for our 4-axis (2×2) hot-wire cutter: load a root and tip profile, sync them, apply kerf, and export Mach3 G-code. Hosted on GitHub Pages; everything runs client-side.

Status: **draft for review** (2026-10-18). Decisions below came from the feature interview; open items are at the end.

---

## 1. What DevFoam does today (reverse-engineered from our example)

Reference: `V2MakoVtail_4inback.nc` from `Vtail bottom.DXF` (root) + `Vtail top.DXF` (tip).

| Aspect | Observed |
|---|---|
| Units / mode | `G20` inches, `G17`, `G90` absolute |
| Feed | `G93` inverse-time; each `G1` carries `F` = 1/minutes for that segment. Base speed `F7.874` in/min = 200 mm/min |
| Axes | `X,Y` = left carriage (horizontal, vertical); `A,Z` = right carriage |
| Wire | `M3` on at start, `M5` off at end |
| Sequence | `G0` to home (4.01, 0.178) → straight `G1` to loop start → LE tab → lower surface → TE tab (rounded end) → upper surface → LE tab (rounded end) → `G1` back to home |
| Projection | Paths are extrapolated from the foam faces out to the carriage planes (root grows ~12.9″ → ~16.7″ of X travel; tip shrinks) |
| Kerf | Offset outward, **different per side** (≈0.09″ root, ≈0.12″ tip at carriage); convex corners rounded |
| Sync | ~680 point-for-point matched segments, ≈0.05″ spacing, matched per section (tab / lower / tab / upper) |
| Speed | Segment time ≈ governed by the larger (faster) foam face |

DXF content (SolidWorks export): per profile, 2 cubic NURBS `SPLINE`s (upper/lower surface) + 6 `LINE`s forming a 0.5″ LE tab and 1.5″ TE tab, plus `MTEXT` watermarks ("SOLIDWORKS Educational Product") that must be ignored. Root and tip are aligned at the TE (swept LE).

---

## 2. Decisions

| Topic | Decision |
|---|---|
| Delivery | Static web app on **GitHub Pages** (personal repo first, team org later). No server; files never leave the browser. |
| Stack | **TypeScript + Vite**, **React** for UI, **Three.js** (via react-three-fiber) for 3D, **Vitest** for tests, GitHub Actions for test+build+deploy. |
| Inputs | **DXF** (LINE, ARC, LWPOLYLINE/POLYLINE, SPLINE, CIRCLE; ignore TEXT/MTEXT/DIMENSION) and **SVG** (paths; user supplies scale/units on import). |
| Controller | **Mach3/Mach4.** Output defaults match the example (G93, XYAZ) and are fully editable per machine. |
| Units | Inches and mm. DXF `$INSUNITS` is read on import; output units come from the machine preset. |
| Presets | Bambu-style **Machine / Material / Job** split. Machine and material presets are **JSON in the repo**, selected from a list. A **Machine editor** and **Material editor** are built in. |
| Parts per job | One panel per job (v1). Data model leaves room for multi-part. |
| Projects | One `.hfoam.json` file per job, embedding profiles + all settings. |
| Build order | Core first (M1 → M2 → M3, §9). |

---

## 3. Core concepts

**Profile**: a closed (or open) chain of geometric entities for one face of the part (root or tip).

**Segment**: a stretch of a profile between two **split points**. Root and tip must have the **same number of segments**; segment *i* on the root is cut together with segment *i* on the tip. Split points are therefore the primary sync points.

**Pin**: an optional extra sync pair *inside* a matched segment pair (root pin *k* ↔ tip pin *k*). Used for finer control, e.g. with twist. Pins subdivide a segment for resampling only.

**Station**: one resampled point pair (root point, tip point). The final path is a list of stations; each consecutive pair becomes one `G1`.

**Faces vs carriages**: the profiles live on the foam faces. The machine moves the carriages, which sit outside the faces, so every station is projected along the wire line out to each carriage plane.

---

## 4. Features

### 4.1 Import
- DXF: parse entities, evaluate NURBS splines (de Boor, honoring knots and weights), chain entities end-to-end within a join tolerance, and detect closed loops. Report gaps or dirty geometry with a visual marker and offer "auto-join within tolerance".
- SVG: parse `<path>`/basic shapes and flatten transforms. On import, ask for the scale (viewBox → real units, or a DPI) because SVG has no reliable physical units.
- Each entity boundary is remembered as a candidate split.
- Unit detection from `$INSUNITS`; override available.

### 4.2 Segments & sync (the main pain point in DevFoam)
- **Auto-split** on load at every entity boundary and at sharp corners (angle threshold, default 30°).
- **Click to edit**: click a curve to add a split; click a split to delete it; drag a split along its curve (it snaps to entity ends and corners).
- **Pins**: add numbered pin pairs inside segments. Pins are drawn in matching colors on root and tip.
- **Mismatch handling**: when segment or pin counts differ, the offending segments are highlighted and export is blocked, with a one-line explanation.
- **Wire lines**: the 2D overlay draws faint lines between matched stations so twist and bad sync are visible immediately.
- **Loop start & direction**: choose which split is the loop start, and which way the loop runs (CW/CCW).

### 4.3 Transforms (per profile)
- Move (X/Y), scale (uniform or X/Y), rotate (twist/washout) about a pivot. The pivot can be a typed point, % chord, LE or TE.
- Flip vertical / rotate 180° (cut upside down or TE-first).
- **Mirror L/R**: produce the opposite-hand panel (swaps which carriage the root is on).
- Transforms are stored as parameters, not baked in, so they stay editable.

### 4.4 Kerf
- Separate **root** and **tip** kerf values.
- **Auto from speed**: the material preset holds a kerf-vs-wire-speed table. Kerf is computed per station from that face's local speed (the slower tip gets more kerf).
- **Per-segment override**: a segment can set its own kerf, including 0 (e.g. sacrificial tabs, lead-ins).
- Kerf side: outward from the part (inward for holes). A negative value gives a negative part.
- Offsetting is done **per station along the normal**, so root/tip correspondence is preserved. Convex corners get a rounding arc inserted **on both sides with the same point count**, so sync is never broken. Concave self-intersections are detected and trimmed, with a warning.

### 4.5 Resampling
- Mode is chosen per job:
  - **Curvature-adaptive** (default): a chord-error tolerance plus a max step.
  - **Uniform**: fixed step measured on the longer side.
- Within a synced segment (or pin span), both sides are parameterized by **normalized arc length**. The station set is the union of the breakpoints either side needs, so both sides always have equal counts.

### 4.6 Speed
- **Cut speed is defined at the faster foam face**: segment time `t = max(|ΔR|, |ΔT|) / F_cut`.
- **Per-segment speed** override (e.g. slower around the LE).
- **Corner dwell**: optional `G4` pause at corners sharper than a threshold. Duration comes from the material preset.
- **Max carriage speed**: this is a limit, not how speed is set. If any station would drive a carriage over the machine's max speed, the app shows a warning listing where. If the user exports anyway, that segment's time is **stretched in the G-code** so the carriage stays at the cap.
- The output is G93 inverse-time (`F = 1/t`) by default, or G94 units/min (`F` = speed of the faster carriage) if the machine is set that way.

### 4.7 Entry / exit
- The loop starts at the chosen split point.
- Lead-in from home goes through an editable list of **waypoints** (e.g. "straight down to block-top + clearance, then horizontal to the start"). This avoids diagonal plunges through the foam.
- Lead-out goes through waypoints back to home (defaults to the reverse of the lead-in).
- Lead-in and lead-out moves are cut at cut speed, or rapid when they are flagged as outside the block.

### 4.8 Preview & verification
- **2D**: root and tip overlaid (different colors), with segment/pin markers, wire lines, the kerf-offset path, the carriage-projected paths (toggle), and the foam block outline.
- **3D**: machine frame, travel envelope, foam block and the wire, with a playback scrubber and a speed slider. Cut surfaces are rendered as a ruled mesh between root and tip paths.
- **Open existing .nc**: parse any G-code (including DevFoam's) and show it in 2D/3D. Optionally overlay it on our generated path to compare.
- **Limit checks** (shown as a warnings panel, each clickable to its location):
  - out-of-travel on any axis
  - carriage speed over the cap
  - segment/pin count mismatch
  - kerf offset self-intersection
  - part outside the foam block
  - lead-in passing through the block when not intended
  - wire angle beyond what the machine can cut (configurable)

### 4.9 Presets & editors
- Selected from dropdowns, like a slicer's printer and filament pickers.
- Repo presets live in `presets/machines/*.json` and `presets/materials/*.json`, bundled at build time. They are read-only in the app.
- **Machine editor** and **Material editor**: edits are saved as local presets in browser storage. An "Export for repo" button downloads the JSON to commit through a PR so the whole team gets it.
- Each project records the preset IDs it used plus a snapshot of their values, so an old project still reproduces the same G-code even after presets change.

### 4.10 Projects
- `.hfoam.json` holds the schema version, the raw profile geometry (embedded, not linked), splits, pins, transforms, kerf/speed/sampling settings, block placement, lead-in/out, and the preset snapshots.
- Save/Open via browser file dialogs.

---

## 5. Data model (TypeScript sketch)

```ts
type Units = 'in' | 'mm';
type Vec2 = { x: number; y: number };

interface MachinePreset {
  id: string; name: string; units: Units;
  carriageSpacing: number;              // distance between left & right carriage planes
  travel: { x: [number, number]; y: [number, number] };  // per carriage
  maxSpeed: number;                     // per-carriage cap, units/min
  rapidSpeed: number;
  maxWireAngleDeg?: number;
  home: { left: Vec2; right: Vec2 };
  axes: { leftH: string; leftV: string; rightH: string; rightV: string }; // 'X','Y','A','Z'
  feedMode: 'G93' | 'G94';
  decimals: number;
  gcode: { header: string; footer: string; wireOn: string; wireOff: string; dwell: string }; // templates
}

interface MaterialPreset {
  id: string; name: string; units: Units;
  cutSpeed: number;                                   // at faster foam face
  kerfTable: { speed: number; kerf: number }[];       // for auto-kerf
  cornerDwell?: { angleDeg: number; seconds: number };
}

interface Split { profile: 'root' | 'tip'; s: number }   // arc-length position on the chain
interface Pin   { id: number; root: number; tip: number }
interface SegmentOverride { index: number; kerf?: number; speed?: number }

interface Job {
  schema: 1;
  machine: MachinePreset;  material: MaterialPreset;   // snapshots
  root: ProfileSource; tip: ProfileSource;              // raw entities + transform
  splits: Split[]; pins: Pin[]; overrides: SegmentOverride[];
  loopStart: number; direction: 'cw' | 'ccw';
  kerf: { mode: 'fixed' | 'auto'; root: number; tip: number };
  sampling: { mode: 'adaptive' | 'uniform'; tol: number; maxStep: number; step: number };
  block: { span: number; rootFaceFromLeft: number; rootSide: 'left' | 'right';
           size: { w: number; h: number }; origin: Vec2 };
  leadIn: Vec2[]; leadOut: Vec2[] | 'reverse';
}
```

---

## 6. Pipeline

Pure functions in `src/core`, no DOM:

```
DXF/SVG ─► parse ─► entities ─► chain/clean ─► Profile (root, tip)
                                                   │ transforms
                                                   ▼
                       splits + pins ─► matched spans (root_i ↔ tip_i)
                                                   │ resample (adaptive|uniform)
                                                   ▼
                                     stations [(R_k, T_k)]
                                                   │ kerf offset (per side, per station, sync-preserving)
                                                   ▼
                                     offset stations + corner arcs
                                                   │ add lead-in/out waypoints
                                                   ▼
                                     projection to carriage planes
                                                   │ speed / dwell / cap
                                                   ▼
                                     moves [(L, R, t)] ─► validate ─► G-code writer
```

**Projection.** Put the left carriage at z = 0 and the right carriage at z = D (`carriageSpacing`). The root face is at z_r and the tip face at z_t (from block placement, swapped when the root is on the right). For a station with root point R and tip point T, the wire point at depth z is

  P(z) = R + (T − R) · (z − z_r)/(z_t − z_r)

so Left = P(0) and Right = P(D).

**Timing.** For each move, `t = max(|ΔR|, |ΔT|) / F_seg`. If `max(|ΔL|, |ΔRc|)/t > maxSpeed`, warn, and on export set `t = max(|ΔL|, |ΔRc|) / maxSpeed`.

**Auto-kerf.** The per-face speed is `|Δface|/t`. Look up kerf in the material table by linear interpolation, then offset. One fixed-point pass is enough because kerf barely changes path length.

---

## 7. Repo layout

```
HuskyFoam/
  docs/SPEC.md
  presets/machines/*.json      presets/materials/*.json
  src/core/                    # framework-free, fully unit-tested
    io/dxf.ts  io/svg.ts  io/gcodeParse.ts  io/project.ts
    geom/nurbs.ts  geom/chain.ts  geom/polyline.ts  geom/transform.ts
    sync/segments.ts  sync/resample.ts
    cut/kerf.ts  cut/projection.ts  cut/timing.ts  cut/leads.ts
    gcode/writer.ts
    validate/checks.ts
  src/ui/                      # React
    App.tsx  JobPanel/  Canvas2D/  View3D/  MachineEditor/  MaterialEditor/  Warnings/
  tests/fixtures/              # reference DXFs + DevFoam .nc
  .github/workflows/pages.yml  # test → build → deploy
```

Libraries:
- `dxf-parser` for DXF entity extraction, with our own NURBS evaluator.
- `three` + `@react-three/fiber`.
- Optionally `clipper2-js` for the self-intersection check only. The main offset is our own, to keep sync.

---

## 8. Testing

- **Regression vs DevFoam.** Back-solve the machine/kerf/speed settings from the more accurate reference `.nc` you'll provide, then keep an automated test: same DXFs in → carriage paths within a tolerance (e.g. 0.005″) of DevFoam's, after resampling both to compare.
- Unit tests for NURBS evaluation, chaining, resampling equal-count invariants, kerf offset on simple shapes (rectangle, circle), the projection identity (a station with R = T gives L = R = R), and the G93 feed math.
- A G-code round trip: writer → our parser → identical moves.

---

## 9. Milestones

**M1 — Core cut (usable for the V-tail case)**
- DXF import (LINE/ARC/SPLINE/LWPOLYLINE), chaining, auto-split at entity boundaries and corners
- Equal-count resampling (uniform + adaptive), fixed root/tip kerf, projection, timing with speed cap and warning
- Lead-in/out waypoints, G-code writer (G93/XYAZ template)
- One hard-coded machine/material loaded from `presets/` JSON
- 2D preview with wire lines; basic warnings
- Regression test against the reference `.nc`
- GitHub Pages deploy

*Done when: our output matches DevFoam's on the reference part within tolerance, and someone can cut from it.*

**M2 — Editing & presets**
- Click/drag split editing, pins, loop start/direction
- Transforms (twist/pivot, mirror L/R, move/scale, flip)
- Per-segment kerf/speed overrides, auto-kerf from speed table, corner dwell
- Machine editor + Material editor (local storage + "Export for repo"), preset pickers
- Project save/open

**M3 — Visualization & polish**
- 3D view with playback
- Open/compare existing `.nc`
- SVG import
- Full limit-check suite, keyboard shortcuts, docs page

---

## 10. Open items
1. **Reference G-code for back-solving**: you'll provide a more accurate `.nc` (and the DXFs it came from). Please also give the DevFoam settings used, if you can see them (kerf, speed, block placement, carriage distance).
2. **Machine facts**: carriage spacing, travel limits, max speed, home position, and whether Mach3 needs anything beyond `M3`/`M5` (e.g. a wire-heat `S` value or a spindle delay). These go into the first machine preset.
3. **What "4inback" means** in the example filename (block offset? lead-in?). This helps interpret the reference.
4. The repo is a personal GitHub repo for now. Note that this folder currently sits inside a git repo rooted at your home directory, so HuskyFoam should get its own `git init` before the first commit.
