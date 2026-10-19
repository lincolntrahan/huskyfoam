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

### Sync points: splits and pins

Splits are where root and tip are matched (segment N on the root is cut with segment N on the tip). They start out automatic (entity boundaries + sharp corners) and you can edit them:

- **Click a profile outline** to *add a split* or *add a pin*. The matching one is added on the other profile at the same relative position.
- **Drag** a split or pin marker to slide it along its own profile.
- **Click a split** for *Make loop start* or *Remove split* (removes the pair).
- **Pins** (purple diamonds) line up a root point with a tip point inside a segment (e.g. LE to LE) without creating a new segment.
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

## Presets

Machine and material presets are JSON files in [`presets/`](presets). To change one for the whole team, edit or add a file and open a PR. In-app editors are planned for M2.

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
