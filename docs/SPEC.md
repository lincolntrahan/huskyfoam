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
Superseded by the **cut plan** (§4.10). Lead-in and lead-out are just the plan's first and last inserted lines. M1 ships a simpler version: a list of straight-wire waypoints that runs home → waypoints → loop start, and back the same way.

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

### 4.10 Cut plan: run-outs, jogs and run-ins
The wire doesn't have to go around the profile in one loop. The **cut plan** is an ordered list of **steps** from home back to home. Use cases:
- **LE→TE twice**: cut the upper surface LE→TE, run out aft, jog over the block back to the front, run in, then cut the lower surface LE→TE. Both surfaces are cut in the same direction, with no wrap around the LE.
- **Out-and-back**: at a thin trailing edge or any pointed feature, run out past the point and come straight back in along the same line, so the wire never has to turn the sharp corner inside the foam.

**Steps**
- **Segment step**: one matched root/tip segment pair (§4.2), traversed **forward or reversed**. Segments can be reordered or skipped.
- **Line step**: a straight line the user inserts, marked **cut** or **jog**.
  - *Cut* lines run at cut speed (timed at the faster face, like profile segments). Use them for run-outs and run-ins through foam.
  - *Jog* lines run at the machine's **jog speed** as coordinated `G1` moves, not `G0`, so the carriages stay in sync. Use them for moves through air. Jogs are still subject to the carriage speed cap.

**Points.** Line steps connect **plan points**, which are shared between consecutive steps so dragging one moves both lines:
- *Split point*: attached to matched split *k*. On each face it resolves to that face's **kerf-offset** point (see Kerf below).
- *Free point*: a single XY used on both faces, i.e. a straight wire. This is the default for anything off the profile.
- *Unlocked free point*: separate root and tip XY, for when a run-out has to follow the taper. Toggle it per point.
- *Home*: the machine home. The plan always starts and ends there.

**Kerf.** Inserted lines are **not** offset. They attach to the kerf-offset profile, so the part is still cut to size.
- Kerf is computed once on the full closed loop (as in M1). Each segment step then takes its slice of the offset loop.
- A convex-corner arc between segments *k* and *k+1* is included only when the plan cuts *k* then *k+1* consecutively (or the reverse).
- Otherwise the segment ends at its own side of the arc, and a line attached to that split attaches there.

**Continuity.** Each step must start where the previous one ended.
- Any gap is shown on the canvas and in the step list, and **blocks export**.
- One-click fixes: **bridge with jog** or **bridge with cut**.
- Nothing is ever bridged silently.

**Foam block.** The job gets a block rectangle (X, Y, width, height; the same on both faces), drawn on the canvas. Checks:
- A **jog that passes through the block** on either face. It would cut foam at jog speed.
- A cut line whose free end sits inside the block. The wire would stop in the foam.
- **Uncut segments**: a segment the plan never cuts.
- **Repeated segments**: a segment cut twice.
- The usual travel-limit and speed-cap checks (§4.8), applied to jogs too.

**Templates** (one click; they replace the current plan after confirming):
- **Loop**: home → run-in → every segment forward from the loop start → back to the start → home. This is exactly the M1 behaviour, and it's the default.
- **LE→TE top & bottom**: guesses the LE and TE splits (min/max X on the root; both can be moved), then:
  - run in from in front of the block to the LE
  - cut the upper segments LE→TE (reversed traversal)
  - run out aft of the block
  - jog up over the block (top + clearance) and forward
  - run in to the LE
  - cut the lower segments LE→TE
  - run out, then jog home
- **Out-and-back at a split**: inserts *split → free point → split* (both cut) at the selected split. The free point sits along the outward corner bisector at a typed distance (default: just past the block edge).

**Editing (canvas + step list)**
- *Canvas*: click a split marker to get **Run out from here / Run in to here / Out-and-back here**. Click empty space to add the next free point of the line being drawn. Drag free points to move them (Shift-drag to unlock root/tip). Click a line to toggle cut/jog, insert a point on it, or delete it.
- *Drawing style*: cut lines solid, jogs dashed, both with direction arrows. Steps are numbered in order.
- *Step list* (sidebar): every step in order, with its type, endpoints and length. Per step you can set **cut/jog**, **reverse** (segment steps), **skip/delete** and drag to **reorder**. Gap rows appear in red with the bridge buttons.

### 4.11 Projects
- `.hfoam.json` holds the schema version, the raw profile geometry (embedded, not linked), splits, pins, transforms, kerf/speed/sampling settings, block placement and rectangle, the cut plan, and the preset snapshots.
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
  jogSpeed: number;                     // coordinated G1 speed for jog lines (faster carriage)
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
           rect: { x: number; y: number; w: number; h: number } };  // same rectangle on both faces
  plan: CutPlan;
}

// ---- Cut plan (§4.10) ----
type PointId = string;
type PlanPoint =
  | { kind: 'home' }
  | { kind: 'split'; split: number }            // matched split k -> kerf point on each face
  | { kind: 'free'; p: Vec2 }                   // straight wire (same XY both faces)
  | { kind: 'freePair'; r: Vec2; t: Vec2 };     // unlocked: separate root/tip XY

type PlanStep =
  | { id: string; kind: 'segment'; seg: number; reversed: boolean }
  | { id: string; kind: 'line'; from: PointId; to: PointId; speed: 'cut' | 'jog' };

interface CutPlan {
  points: Record<PointId, PlanPoint>;  // shared, so dragging a point moves both lines that use it
  steps: PlanStep[];                   // home -> ... -> home
  template?: 'loop' | 'le-te' | 'custom';
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
                                     offset stations + corner arcs (full closed loop)
                                                   │ walk the cut plan: slice segments (fwd/rev),
                                                   │ resolve plan points, insert line steps,
                                                   │ check continuity & block collisions
                                                   ▼
                                     face path [(R, T, speedClass)]
                                                   ▼
                                     projection to carriage planes
                                                   │ speed / dwell / cap
                                                   ▼
                                     moves [(L, R, t)] ─► validate ─► G-code writer
```

**Projection.** Put the left carriage at z = 0 and the right carriage at z = D (`carriageSpacing`). The root face is at z_r and the tip face at z_t (from block placement, swapped when the root is on the right). For a station with root point R and tip point T, the wire point at depth z is

  P(z) = R + (T − R) · (z − z_r)/(z_t − z_r)

so Left = P(0) and Right = P(D).

**Timing.** For each cut move, `t = max(|ΔR|, |ΔT|) / F_seg`. For a jog move, `t = max(|ΔL|, |ΔRc|) / jogSpeed` (timed at the carriages, since a jog is through air). For any move, if `max(|ΔL|, |ΔRc|)/t > maxSpeed`, warn, and on export set `t = max(|ΔL|, |ΔRc|) / maxSpeed`.

**Plan walk.**
- Segment step *k*:
  - Take its stations from the offset loop, from the arc end at its start corner to the arc start at its end corner. Reverse them when `reversed`.
  - Include a corner arc only when the previous step was the neighbouring segment, continuing in the same direction.
- Line step: resolve both points to (R, T) pairs.
  - `split` → that split's kerf point on the side the adjacent segment step uses
  - `free` → (p, p)
  - `home` → (home, home)
  - Emit them as one straight move.
- Continuity: the end of step *i* must equal the start of step *i+1* within 1e-6, otherwise it's a gap error.
- Block check: for jog lines, test the face segment against the block rectangle on each face (and the projected wire between them, which is linear, so checking both faces is sufficient).

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
    cut/kerf.ts  cut/projection.ts  cut/timing.ts
    plan/model.ts  plan/walk.ts  plan/templates.ts  plan/checks.ts
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

- **Sanity check vs DevFoam** (done in M1). The V-tail reference was back-solved: span 12.07 on 36″, kerf 0.0998/0.1116. Our 4D carriage path is within 0.0035″ RMS and the cut time within 0.03%. The reference runs "a little weird" on the machine, so this is a ballpark check, not ground truth.
- Unit tests for NURBS evaluation, chaining, resampling equal-count invariants, kerf offset on simple shapes (rectangle, circle), the projection identity (a station with R = T gives L = R = R), and the G93 feed math.
- A G-code round trip: writer → our parser → identical moves.
- **Cut plan:**
  - The Loop template reproduces M1's G-code byte-for-byte.
  - LE→TE on the V-tail cuts every airfoil segment exactly once, with no gaps.
  - Out-and-back returns to the same kerf point.
  - A jog through the block is flagged.
  - A deliberate gap blocks export, and "bridge with jog" fixes it.
  - Reversed segments are the exact reverse of forward ones.

---

## 9. Milestones

**M1 — Core cut (usable for the V-tail case)**: ✅ done (commit `1bbf00d`)
- DXF import (LINE/ARC/SPLINE/LWPOLYLINE), chaining, auto-split at entity boundaries and corners
- Equal-count resampling (uniform + adaptive), fixed root/tip kerf, projection, timing with speed cap and warning
- Lead-in/out waypoints, G-code writer (G93/XYAZ template)
- One hard-coded machine/material loaded from `presets/` JSON
- 2D preview with wire lines; basic warnings
- Regression test against the reference `.nc`
- GitHub Pages deploy

*Done when: our output matches DevFoam's on the reference part within tolerance, and someone can cut from it.*

**M2a — Cut plan**: ✅ done (PR #1)
- Plan model + walk (segments fwd/rev, line steps, shared points), replacing M1's waypoint lead-in
- Foam block rectangle on the job; jog speed on the machine preset
- Templates: Loop (default; M1-identical until the M2c lead change), LE→TE top & bottom, Out-and-back at a split
- Canvas editing: split-marker menu, click to place points, drag/Shift-drag, line cut/jog toggle; direction arrows
- Step list: reorder, reverse, skip, cut/jog, gap rows with bridge fixes
- Checks: gaps (block export), jog through block, cut ending in foam, uncut/repeated segments

**M2b — Editing & presets** ✅ done (PRs #2, #3, #4)

*PR 1 — Sync editing*
- Root / Tip / Both visibility toggle for every face-specific layer (profiles, kerf loop, plan paths, markers, unlocked handles, the matching carriage path).
- Splits are stored as arc-length positions on each profile (`job.sync`, null = automatic). Edits:
  - **Drag** a split along its own profile.
  - **Add** a split by clicking a profile outline. The matching split is added automatically on the other profile at the same relative position within that segment, so the counts always match.
  - **Remove** a split, which removes the pair.
  - **Make loop start**.
- **Pins**: numbered sync pairs inside a segment. They align root and tip stations (e.g. LE ↔ LE under twist) without creating segments. Add them like splits (auto-paired), drag them, remove them.
- **Loop direction**: a "Loop (reverse)" template; it's all segments reversed, so kerf stays outward.
- **Plan remap on split edits**:
  - Moving a split keeps the plan.
  - Adding a split turns that segment step into two steps (same direction).
  - Removing a split merges two steps when they're consecutive in the plan; otherwise the plan resets to Loop with a warning.
  - Changing the loop start renumbers segments and split references.

*PR 2 — Transforms*
- Twist/washout about a pivot. The default pivot is 25% chord, with LE, TE or a typed point as alternatives. The UI states clearly that this twist is **in addition to any twist already in the CAD profiles**, so most jobs won't need it.
- Mirror L/R, move/scale, flip/rotate 180°.

*PR 3 — Presets & projects* (also: material wire power in watts, written as a G-code comment and `{wireWatts}` header token)
- Machine editor + Material editor (local storage + "Export for repo") and preset pickers.
- The machine preset gets "G4 P is seconds / milliseconds" (default seconds, Mach3's default).
- Per-segment kerf/speed overrides, auto-kerf from a speed table, corner dwell.
- Project save/open (`.hfoam.json`).

**M2c — Shop setup & multiple contours** (PRs #9, #10)

*PR #9 — Shop machine, left/right setup, linked sync*
- Shop machine: 43.25 in carriage spacing, 29 x 12.5 in travel (from the DevFoam machine settings).
- Define Setup uses left/right wording: block width plus the gap from each carriage, each derived from the other.
- Splits and pins can be **linked**: dragging one end keeps the other at the same relative position (a split within the stretch between its neighbours, a pin within its segment).

*PR #10 — Multiple contours*
- Default lead in / out: jog vertically from home to the start split's height, cut horizontally to it (and the reverse at the end), via a `level` plan point that follows split edits. Profile moves are unchanged; the M1 fixtures were regenerated for the new leads.
- A profile is a list of contours: the outer outline (largest closed) first, then holes and open chains. Auto pick takes the outline and everything inside it.
- Open contours: arc positions don't wrap; a split at each end (fixed); n splits make n-1 segments.
- **Pairing**: root contour i is cut with tip contour `job.contours.pairs[i]` (-1 = not cut). Automatic pairing matches centroids normalised to each side's outline bounding box, closed with closed and open with open.
- **Sync** per pair: pair 0 in `job.sync`, the others in `job.contours.sync[rootIndex]`, all on the raw contours. Transforms come from the outer contour and apply to every contour.
- **Numbering**: splits and segments are numbered globally, pair after pair. A `Topology` records each contour's first split and segment and whether it's closed; plan walking, remaps and templates use it.
- **Default plan**: with automatic sync, the outline gets a split at its closest point to each other contour, and each closed contour starts at its point nearest that split. The Loop template cuts in along a cut line, all the way round (open: to the end and back), and back out to the same outline split before continuing.
- **Kerf side** per pair: outside / inside (closed), left / right of drawing direction (open), or none. Auto is outside for the outline, inside for holes (contours inside the outline), none for open contours. Offsetting left is offsetting right along the reversed path.

**M2d — Automatic placement** (PR #11)
- Pages 2 and 3 swap: *Arrange Profiles* (profile distance, transforms; drag a profile to move it relative to the other) comes before *Place in Machine* (machine, material, placement, block).
- `job.layout`: left carriage to left profile plane (dual left/right entry), floor offset, block size (w, h, len) and three alignments (along the wire, along the chord, vertical).
- `placeJob` resolves it before cutting: profile planes from the layout; part offset Y so the lowest profile point is the floor offset above Y = 0; part offset X so the closest carriage position on the kerfed cut is at the travel minimum; block rectangle and ends from the alignments. A first cut at zero offset supplies the geometry (the cut is translation-invariant). While a profile is dragged the offset is held.
- Shop machine home is (0, 0). Older projects get a layout that keeps their profile planes and block size.
- Floor offset defaults to 0.25 in (6 mm). If the lowest carriage position on the kerfed cut would fall below the Y travel minimum, the part is raised to put it exactly there instead, and Place in Machine shows the resulting profile height (PR #12).

**M2e — Import pairing, rotation, linked splits** (PR #13)
- Import: per-profile rotation in 90° steps (`job.rotation`, applied to the DXF geometry on load, exact). Contours are numbered and coloured by pair on both pickers; the pairing table moves to Import, the kerf-side table stays on Segment.
- Auto pairing: with equal counts of closed (and of open) inner contours, pair by order along the outline's long axis (then across it); otherwise by nearest normalised position.
- Splits are linked unless `sync.linked[k] === false`; unlinked splits get a dashed ring. Pins are no longer offered (old projects keep theirs and can remove them).
- While a pair has different split counts on root and tip, the pipeline stops at the segment stage but still reports each side's splits; the canvas then offers one-sided `addSplitOn` / `removeSplitOn` (root edits renumber the plan, tip edits don't) and dragging a split no longer moves a partner. Sync edits carry the job's stored plan, since an errored result has none.

**M2f — Sequencing redesign** ✅ done (PR #14)

*Goal*: Sequence Cuts becomes a feature tree you build pair by pair, like a CAD feature tree, instead of one global plan you edit after the fact.

*Starting state*
- A new job's plan is **empty**. The canvas draws each contour pair in its pair colour (the same colours as on Import), and nothing is cut yet.
- Sequence Cuts reports *"Nothing sequenced yet"* as an error until every pair is cut, so Preview and Export stay locked until then.
- **Sequence all** builds the default in one click:
  - every inner pair first, in order along the chord, each with a vertical plunge;
  - then the outline as a Loop;
  - jogs between them, and a final jog home.
- Older projects (saved with no plan, which meant "the default loop") still open with that loop, so their G-code doesn't change.

*Templates, applied to one pair at a time*
- Pick a pair by clicking a contour on the canvas or its chip in the panel, then press a template.
- The template's steps go into a **folder** named for the pair, e.g. "Pair 2 · Loop".
  - Applying a template again to the same pair replaces its folder in place.
  - Otherwise the folder is inserted at the rollback bar.
- **Inner pairs** (holes): *Loop* or *Loop (reverse)*.
  - Jog over the block to directly above the contour's start split.
  - Cut vertically down to the start split.
  - Cut all the way round.
  - Cut vertically back up the same way to the safe height.
- **The outline**: *Loop*, *Loop (reverse)* or *LE→TE top & bottom*, entering and leaving the way they do today (straight up from home, across to the start; the reverse on the way out).
- Open contours keep the in-and-back cut: plunge in to the start, cut to the end and back, then cut out.

*Inner contour start split*
- With automatic splits, each closed inner contour starts at its **highest point on each face**, so the plunge slot down through the part is as short as possible.
- The extra splits on the outline next to each hole (used by the old default plan) are only added for old projects that still use the old default.

*Jogs*
- A new step kind, **jog to a point**. It starts wherever the wire is, so reordering never leaves a gap.
- Routes:
  - **Over the block** (the default): straight up to the safe height, across, then down to the target, on both faces at once.
  - **Straight**: a direct move, for moves clear of the foam.
- **Safe height** = the top of the block (or of the profiles, when no block is set) plus a jog clearance. The clearance is a job setting, default 0.5 in.
- Templates add the jog that connects their folder to whatever comes before it (the "auto-connect"). That jog is an ordinary step you can edit or delete.

*Folders*
- One level only: folders hold steps, never other folders.
- Stored on the plan as `groups` (id, name, pair, template), with each step carrying its group id. A folder is the run of consecutive steps in its group, so walking, remaps and G-code don't change.
- Folders can be collapsed, renamed, deleted (with their steps) and dragged. You can also make empty folders of your own.

*Editing the tree*
- **Drag** a step to reorder it, or drop it on a folder to move it in. **Drag** a folder to move all its steps.
- **Rollback bar**: a bar in the step list that you drag up.
  - Steps below it are hidden in 2D, 3D and playback, so the canvas shows the cut "so far".
  - Export always writes the whole sequence, with a reminder if the bar isn't at the bottom.
  - The bar isn't saved: it goes back to the bottom when you reopen the project.
- **Insert at the bar**: *+ Jog to…* (click a split, or Home), *+ Cut line* (click points like a run-out), *+ Segment* (click a segment on the canvas), *+ Folder*. New steps go just above the bar.

*Selection*
- Selecting a step makes it stand out on the canvas: drawn thick and bright, everything else dimmed. Its row in the list is highlighted and scrolled into view.
- Clicking a cut on the canvas selects its step, and the step with it.

*Unchanged*
- Run-out drawing, out-and-back, cut/jog toggles, bridging, the per-segment kerf/speed overrides, and the checks (jog through the foam, cut ending in the foam, segments never cut or cut twice).

**M3 — Visualization & polish**
- 3D view with playback
- Open/compare existing `.nc`
- SVG import
- Full limit-check suite, keyboard shortcuts, docs page

---

## 10. Open items
1. **Machine facts**: carriage spacing (43.25 in) and travel (29 x 12.5 in) are in. Home is (0, 0). Still needed: max speed, **jog speed**, and whether Mach3 needs anything beyond `M3`/`M5` (e.g. a wire-heat `S` value or a spindle delay).
2. **What "4inback" means** in the example filename (block offset? lead-in?), and why the DevFoam file runs "a little weird" on the machine. That may point to something our output should do differently.
3. **Hosting**: resolved. The repo is public and deploys to https://lincolntrahan.github.io/huskyfoam/ on every push to `main`. Moving it to the team org later is still an option.
