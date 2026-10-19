# HuskyFoam

A browser app for cutting tapered foam parts (wing cores, tail surfaces) on a 4-axis hot-wire CNC. It replaces the DevFoam "tapered part" workflow: load a root and a tip DXF, check the sync and kerf in the preview, and export Mach3 G-code.

**Use it:** https://lincolntrahan.github.io/huskyfoam/

Everything runs in the browser, so files never leave your computer. See [docs/SPEC.md](docs/SPEC.md) for the full design and roadmap.

## Using it

1. Pick the machine and material at the top.
2. Open the **root** and **tip** DXFs, or click **Load V-tail example**.
3. Set the block placement, kerf and speed.
4. In the preview, check that the numbered sync points line up (1 ↔ 1, 2 ↔ 2, …) and that the grey wire lines look right.
5. **Export G-code**.

Preview controls: scroll to zoom, drag to pan, double-click to re-fit.

### Choosing geometry from a DXF

On **Import Geometry** each file is drawn with all of its entities:

- **Click** an entity to include or exclude it.
- **Drag a box** to include everything inside it; **Shift-drag** excludes.
- **Right-drag** pans, the wheel zooms, and double-click fits.
- Text (title blocks, *SOLIDWORKS Educational* watermarks) is shown in grey and never cut.
- *Auto pick* (the default) uses the largest closed outline plus every contour inside it (spar holes, slot lines).
- The status line says whether your selection forms a closed outline.

### Several contours: spar holes and open cuts

A profile can have more than one contour: the closed outer outline plus holes (spar channels) and open lines. Pick them on Import like any other geometry.

- **Pairing**: each root contour is cut with a tip contour. They're paired by where they sit in the outline, and you can change a pairing in the **Contours** table on *Segment Profiles* (or set a contour to *not cut*).
- **Sync**: every contour has its own splits and pins, edited on the canvas as usual. Split numbers run on from one contour to the next.
  - A closed contour's first split is its start; click a split and choose *Make contour start* to move it.
  - An open contour has a fixed split at each end.
- **Default plan**: the outline gets an extra split at the point nearest each other contour. The cut leaves the outline there, goes round the hole (or along the open line and back), and returns to the same split before carrying on round the outline. Edit it on *Sequence Cuts* like any plan.
- **Kerf side**, per contour, in the Contours table:
  - Closed contours: outside or inside. *Auto* is outside for the outline and inside for holes.
  - Open contours: left or right of the direction they were drawn in. *Auto* is none, so the wire runs on the line.
  - Turn on the kerf layer to check which side was used.

### Block position (Define Setup)

Setup talks in left and right carriages, like DevFoam:

- Enter the **block width** (left face to right face, along the wire).
- Then measure the gap from **either** carriage to the block. Typing the left gap fills in the right one (right = carriage spacing − width − left), and the other way round.
- **Root profile on** picks which carriage cuts the root DXF.

### 3D view

The **2D / 3D** switch above the canvas works on every page, and *Preview Cut Path* opens in 3D. It shows:

- the machine (both carriage planes and the travel envelope)
- the foam block
- both profiles
- the surface the wire cuts through the block
- the wire
- both carriage paths

Each has a checkbox. **▶** plays the cut at 1–100×, and the slider scrubs. Drag to orbit, right-drag to pan, scroll to zoom.

### Sync points: splits and pins

Splits are where root and tip are matched (segment N on the root is cut with segment N on the tip). They start out automatic (entity boundaries + sharp corners) and you can edit them:

- **Click a profile outline** to *add a split* or *add a pin*. The matching one is added on the other profile at the same relative position.
- **Drag** a split or pin marker to slide it along its own profile.
- **Click a split** for *Make loop start* or *Remove split* (removes the pair).
- **Pins** (purple diamonds) line up a root point with a tip point inside a segment (e.g. LE to LE) without creating a new segment.
- **Link**: click a split or pin and choose *Link* to keep its root and tip ends at the same relative position while you drag either one.
  - A linked split keeps the same fraction of the stretch between its neighbouring splits.
  - A linked pin keeps the same fraction of its segment.
  - Linking snaps the other end to match the one you clicked. Linked splits get a white connector line, and linked pins a solid one.
- *Reset splits & pins to automatic* undoes all of it.

When splits change, a custom cut plan is carried over where possible. If it can't be, it resets to Loop and tells you.

The **Root / Tip / Both** switch on the canvas shows one face at a time (profile, kerf, plan, markers and that side's carriage path).

### Transforms

The **Transforms** section adjusts each profile without going back to CAD:

- **Twist (°)**: separate for root and tip; positive = leading edge up.
  - It is **added on top of** any twist already drawn in your DXFs. If the CAD profiles already include washout, leave it at 0.
  - It rotates about a pivot: 25% chord by default, or the LE, the TE, or a typed point.
  - The LE/TE are found automatically, ignoring straight tabs. To use your own, click a split marker → *Use as LE / TE*.
- **Scale** and **Move**: per profile. *Link root & tip* (on by default) applies them to both.
- **Flip horizontal / vertical**: applies to both profiles (cut TE-first or upside down; both together = rotate 180°). Flipping resets the cut plan, since segment numbering changes.
- **Mirror L/R** (next to *Root on*): cuts the opposite-hand panel by putting the root on the other carriage.

The canvas shows each profile's chord line with LE/TE labels and a cross at the pivot.

### Cut plan: run-outs, jogs and run-ins

By default the wire goes once around the whole profile (the **Loop** plan). You can change that:

- **LE→TE top & bottom**: cuts the upper surface LE→TE, runs out, jogs back over the foam block, runs in, then cuts the lower surface LE→TE. Set the foam block outline first ("Fit block to part" works).
- **Click a split marker** to get these options:
  - *Run out from here*: click to place points, then click another split marker to run back in, or press Enter / double-click to stop.
  - *Out-and-back here*: for thin trailing edges and points; runs out past the point and straight back.
- **Click a line** to switch it between cut and jog, insert a point, reverse it, or delete it.
- **Drag** the round handles to move points. Shift-drag splits a point into separate root and tip ends.
- The **step list** in the sidebar lets you reorder, reverse and delete steps.
  - If the path jumps somewhere, a red gap row appears with *Bridge with jog / cut*. Export is blocked until every gap is closed.

Jogs are sent as coordinated `G1` moves at the machine's jog speed. You get a warning if a jog passes through the foam block, a cut line stops inside it, or a segment is never cut (or is cut twice).

### How profiles are matched

Each profile is split into segments at every DXF entity boundary and at sharp corners. Segment *N* on the root is cut together with segment *N* on the tip. Both profiles therefore need the same number of segments. The easiest way to get that is to draw root and tip with the same entities (e.g. 2 splines + tab lines), as in the example.

### Kerf, speed, dwell and wire power

- **Kerf**: fixed root/tip values, or *Auto from speed*. Auto uses the material's kerf-vs-speed table, so the slower tip automatically gets a wider kerf.
- **Kerf test** (Material → Edit… → *Kerf test*): downloads G-code that cuts one 1″ square plug at 40/60/80/100% of the cut speed. Measure the plugs, type the sizes in, and *Use these as the kerf table*.
- **Per-segment kerf / speed**: select a segment in the cut-plan list (or click it on the canvas) and fill in the two fields. Blank = the job value.
- **Corner dwell**: pauses (`G4 P…`) at corners sharper than the set angle. Defaults come from the material. Whether `P` is seconds or milliseconds is a machine setting.
- **Wire power (W)**: set per material. It's written at the top of the G-code as a comment and is available to the machine header as `{wireWatts}` (e.g. `M3 S{wireWatts}`).

## Projects

*Save project* writes a `.hfoam.json` with both DXFs, every setting, the cut plan, and snapshots of the machine and material. *Open project…* brings it all back exactly, even if the presets have changed since.

The current job also autosaves in your browser, so a reload picks up where you left off (*Start fresh* clears it).

## Presets

Pick a **machine** and **material** at the top, then use *Edit…* to change them:

- **Team presets** are JSON files in [`presets/`](presets), bundled with the app. Editing one saves a copy in your browser.
- **Browser presets** live only in that browser. *Export for repo* downloads the JSON. Add it to `presets/machines/` or `presets/materials/` and open a PR so the whole team gets it.

> The `shop-4axis` geometry (36″ carriage spacing, travel limits, 30 in/min cap) is a **placeholder**. The example's settings were back-solved from a DevFoam export. Measure the real machine before relying on it.

## Development

Requires Node 20+.

```bash
npm install
npm run dev      # local dev server
npm test         # unit tests + DevFoam sanity check
npm run build    # production build into dist/
```

- `src/core/`: framework-free geometry, sync, kerf, projection and G-code code (unit-tested)
- `src/ui/`: React UI
- `tests/fixtures/`: reference DXFs and the DevFoam G-code used for the sanity check

Pushing to `main` runs the tests and deploys to GitHub Pages (enable Pages → "GitHub Actions" in the repo settings once).
