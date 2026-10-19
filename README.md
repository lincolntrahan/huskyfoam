# HuskyFoam

A browser app for cutting tapered foam parts (wing cores, tail surfaces) on a 4-axis hot-wire CNC. It replaces the DevFoam "tapered part" workflow: load a root and a tip DXF, check the sync and kerf in the preview, and export Mach3 G-code.

Everything runs in the browser, so files never leave your computer. See [docs/SPEC.md](docs/SPEC.md) for the full design and roadmap.

## Using it

1. Pick the machine and material at the top.
2. Open the **root** and **tip** DXFs, or click **Load V-tail example**.
3. Set the block placement, kerf and speed.
4. In the preview, check that the numbered sync points line up (1 ↔ 1, 2 ↔ 2, …) and that the grey wire lines look right.
5. **Export G-code**.

Preview controls: scroll to zoom, drag to pan, double-click to re-fit.

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
