# HuskyFoam

A browser app for cutting tapered foam parts (wing cores, tail surfaces) on a 4-axis hot-wire CNC. It replaces the DevFoam "tapered part" workflow: load a root and a tip DXF, check the sync and kerf in the preview, and export Mach3 G-code.

**Use it:** https://lincolntrahan.github.io/huskyfoam/

Everything runs in the browser, so files never leave your computer. See [docs/SPEC.md](docs/SPEC.md) for the full design and roadmap.

## Using it

The app walks you through seven pages:

1. **Import Geometry**: open the **root** and **tip** DXFs, or click **Load V-tail example**.
2. **Arrange Profiles**: set the distance between the profiles and how they sit relative to each other (twist, scale, move, flip).
   - *Stock generation…* trims a raw board to that distance. Lay the board turned 90° (its future left and right faces at the front and back), confirm the length and thickness, and set how far back from X = 0 it sits, how much to trim off the front and how far the wire steps back before cutting up. The wire cuts down the front, pulls out, jogs over the board, cuts down the back, steps back into the waste and cuts up, so the kept face is cut once; each cut runs half a kerf into the waste. Download the G-code from the dialog.
3. **Place in Machine**: pick the machine and material, say where the profiles are along the wire, how high above the floor, and the foam block.
4. **Segment Profiles**: check that the numbered sync points line up (1 ↔ 1, 2 ↔ 2, …).
5. **Sequence Cuts**: the order of the cut, run-outs and jogs.
6. **Preview Cut Path** and 7. **Export G-Code**.

Preview controls: scroll to zoom, drag to pan, double-click to re-fit.

### Choosing geometry from a DXF

On **Import Geometry** each file is drawn with all of its entities:

- **Click** an entity to include or exclude it.
- **Drag a box** to include everything inside it; **Shift-drag** excludes.
- **Right-drag** pans, the wheel zooms, and double-click fits.
- Text (title blocks, *SOLIDWORKS Educational* watermarks) is shown in grey and never cut.
- *Auto pick* (the default) uses the largest closed outline plus every contour inside it (spar holes, slot lines).
- **⟲ 90° / ⟳ 90°** turn a profile in 90° steps, when the DXF's axes don't match the cutter's (for example a profile exported standing on its leading edge). Each profile turns on its own.
- The status line says whether your selection forms a closed outline.

### Several contours: spar holes and open cuts

A profile can have more than one contour: the closed outer outline plus holes (spar channels) and open lines. Pick them on Import like any other geometry.

- **Pairing**: each root contour is cut with a tip contour. On Import, contours cut together show the same number and colour on both pickers. Holes are paired in order along the outline when both profiles have the same number of them, otherwise by where they sit. Change a pairing (or set a contour to *not cut*) in the **Contour pairs** table under the pickers.
- **Sync**: every contour has its own splits, edited on the canvas as usual. Split numbers run on from one contour to the next.
  - A closed contour's first split is its start; click a split and choose *Make contour start* to move it.
  - An open contour has a fixed split at each end.
- **Sequencing**: each closed hole starts at its highest point. On *Sequence Cuts* the holes are normally cut first, plunged straight down from above the block (see below).
- **Kerf side**, per contour, in the Kerf side table on *Segment Profiles*:
  - Closed contours: outside or inside. *Auto* is outside for the outline and inside for holes.
  - Open contours: left or right of the direction they were drawn in. *Auto* is none, so the wire runs on the line.
  - Turn on the kerf layer to check which side was used.

### Placing the part (Place in Machine)

You only arrange the profiles relative to each other (on *Arrange Profiles*). Where the part sits on the machine is worked out from a few settings:

- **Along the wire**: measure from **either** carriage to its profile. Typing the left gap fills in the right one (right = carriage spacing − profile distance − left), and the other way round. **Root profile on** picks which carriage cuts the root DXF.
- **Height above floor**: the lowest point of either profile sits this far above Y = 0. The default is 0.25 in. On a part with a steep slope between the profiles the carriages go lower than the profiles; if they would pass the machine's Y travel limit, the profiles are raised just enough to keep them in, and the page says how high they ended up.
- **X**: the block's front face (or the profiles' front, with no block) sits the **setback** (default 1 in) from X = 0, so the vertical jogs up from home clear the foam. A swept or tapered part goes further back if a carriage would otherwise pass the X travel limit.
- **Foam block**: its width (along the chord), height and length (along the wire). Three dropdowns place it around the profiles:
  - along the wire: profiles centred, or the left/right profile on that block face;
  - along the chord: profiles centred, or against the −X or +X side;
  - vertically: profiles in the middle, or near the bottom or top face.
  - *Margin to block face* (default 0.1 in) is the foam left between the profiles and the face they're set near: top, bottom, −X or +X. Along the wire the profiles sit flush with the face.
- *Fit block to profiles* sizes the block to just hold both profiles.
- **Shims**: Place in Machine and Export say how far above the floor the block's bottom face has to sit, so you can shim it up. If centring the profiles (or putting them against the top face) would sink the block below the floor, the profiles are raised instead, so the block rests on the floor with them still centred; a note gives their new height.

### 3D view

The **2D / 3D** switch above the canvas works on every page, and *Preview Cut Path* opens in 3D. It shows:

- the machine (both carriage planes and the travel envelope)
- the foam block
- both profiles
- the surface the wire cuts through the block
- the wire
- both carriage paths

On *Export G-Code*, dimension lines show where to set the block: left carriage to its left face, its right face to the right carriage, and X = 0 to its front face.

Each has a checkbox. **▶** plays the cut at 1–100×, and the slider scrubs. Drag to orbit, right-drag to pan, scroll to zoom.

### Sync points (splits)

Splits are where root and tip are matched (segment N on the root is cut with segment N on the tip). They start out automatic (entity boundaries + sharp corners) and you can edit them:

- **Click a profile outline** to *add a split*. The matching one is added on the other profile at the same relative position.
- **Drag** a split marker to slide it. Splits are **linked**: the partner on the other profile moves to the same relative position (the same fraction of the stretch between its neighbouring splits).
- On *Sequence Cuts*, clicking a contour on the canvas selects its pair: its chip under Templates lights up.
- **Click a split** for *Unlink* (it then moves on its own profile only, and gets a dashed ring), *Link again* (snaps the partner to match), *Make contour start* or *Remove split* (removes the pair).
- **Profiles split differently** (e.g. the root and tip drawn from different entities, so the error says "Root has 16 segments but tip has 19"): the split menus switch to one profile at a time. Click an extra split and choose *Remove split (tip only)* (or click a profile to *Add split here (root only)*) until the counts match.
- *Reset splits to automatic* undoes all of it.

Older versions also had *pins* (sync pairs inside a segment). Projects that have them still cut the same; their pins can be removed but not added.

When splits change, a custom cut plan is carried over where possible. If it can't be, it resets to Loop and tells you.

The **Root / Tip / Both** switch on the canvas shows one face at a time (profile, kerf, plan, markers and that side's carriage path).

### Transforms

The **Transforms** section adjusts each profile without going back to CAD:

- **Twist (°)**: separate for root and tip; positive = leading edge up.
  - It is **added on top of** any twist already drawn in your DXFs. If the CAD profiles already include washout, leave it at 0.
  - It rotates about a pivot: 25% chord by default, or the LE, the TE, or a typed point.
  - The LE/TE are found automatically, ignoring straight tabs. To use your own, click a split marker → *Use as LE / TE*.
- **Scale**: per profile. *Link root & tip* (on by default) applies it to both.
- **Move**: per profile, relative to the other one. You can also **drag a profile on the canvas**; a plain click on the outline still sets the LE / TE.
- **Flip horizontal / vertical**: applies to both profiles (cut TE-first or upside down; both together = rotate 180°). Flipping resets the cut plan, since segment numbering changes.
- **Mirror L/R** (on *Place in Machine*, next to *Root profile on*): cuts the opposite-hand panel by putting the root on the other carriage.

The canvas shows each profile's chord line with LE/TE labels and a cross at the pivot.

### Sequencing the cut

*Sequence Cuts* starts empty, with each contour pair drawn in its pair colour. You build the sequence like a CAD feature tree:

- **Templates, one pair at a time**: pick a pair (its chip, or click it on the canvas), then a template. Its steps go in a folder named for the pair; applying another template to the same pair replaces that folder in place.
  - **Holes** (*Loop*, *Loop (reverse)*): jog over the block to straight above the hole's start, cut straight down to it, round the hole, and straight back up. Open lines go along and back.
  - **The outline** (*Loop*, *Loop (reverse)*, *LE→TE top & bottom*): straight up from home to the start's height and across to it; the reverse on the way out. LE→TE cuts the upper surface LE→TE, jogs back over the block, then the lower surface.
- **Sequence all** does every hole first (front to back), then the outline, then a jog home.
- **Jogs** start wherever the wire is, and by default go **over the block**: up to the jog clearance above the block, across, and down. So moving things around never leaves a gap. Click *over* on a jog step to make it a direct move.
- **The step list is a tree**: drag steps and folders to reorder them, drop a step on a folder's name to put it in, and rename (double-click), un-folder (⇱) or delete folders.
- **Rollback bar**: drag it up the list to see the cut only up to that point (2D, 3D and playback). Steps below it are greyed out. Export always writes the whole sequence.
- **Insert at the bar**: *+ Jog to split* (then click a split marker), *+ Jog home*, *+ Cut line* (then click points; click a split to end there), *+ Segment* (then click a profile segment), *+ Folder*.
- **Colours**: every step (in the list and on the canvas) takes the colour of the contour pair it cuts; cuts are solid, jogs dashed. Steps not tied to a pair (like the jog home) are white.
- **Jog nodes**: click the dot at the end of a jog on the canvas to add a segment, a cut line or another jog right after it (the rollback bar moves there).
- **Selecting** a step (in the list, or by clicking its path or segment on the canvas) draws it thick and bright and dims the rest.
- **Click a split marker** to get these options:
  - *Run out from here*: click to place points, then click another split marker to run back in, or press Enter / double-click to stop.
  - *Out-and-back here*: for thin trailing edges and points; runs out past the point and straight back.
- **Click a line** to switch it between cut and jog, insert a point, reverse it, or delete it.
- **Drag** the round handles to move points. Shift-drag splits a point into separate root and tip ends.
- If the path jumps somewhere, a red gap row appears with *Bridge with jog / cut*. Export is blocked until every gap is closed, and until every pair is sequenced.

Projects saved before folders existed keep their old single loop until you apply a template.

Jogs are sent as coordinated `G1` moves at the machine's jog speed. You get a warning if a jog passes through the foam block, a cut line stops inside it, or a segment is never cut (or is cut twice).

### How profiles are matched

Each profile is split into segments at every DXF entity boundary and at sharp corners. Segment *N* on the root is cut together with segment *N* on the tip. Both profiles therefore need the same number of segments. The easiest way to get that is to draw root and tip with the same entities (e.g. 2 splines + tab lines), as in the example.

### Kerf, speed, dwell and wire power

In *Auto from speed table* mode, speeds between two table rows get a kerf interpolated linearly between them.

Kerf is always the **full width** of the slot the wire melts (like a diameter), not one side; the path is offset by half of it on each face. The kerf test works it out as the nominal plug size minus the measured plug side.

A material can set a **minimum feed speed**: if any cut moves a foam face slower than that (usually the slower face of a tapered part), Export warns that the cut may hourglass. It never blocks export.

- **Kerf**: fixed root/tip values, or *Auto from speed*. Auto uses the material's kerf-vs-speed table, so the slower tip automatically gets a wider kerf.
- **Kerf test** (Material → Edit… → *Kerf test*): downloads G-code that cuts one 1″ square plug at 40/60/80/100% of the cut speed. Measure the plugs, type the sizes in, and *Use these as the kerf table*.
- **Per-segment kerf / speed**: select a segment in the cut-plan list (or click it on the canvas) and fill in the two fields. Blank = the job value.
- **Corner dwell**: pauses (`G4 P…`) at corners sharper than the set angle. Defaults come from the material. Whether `P` is seconds or milliseconds is a machine setting.
- **Wire power (W)**: set per material. It's written at the top of the G-code as a comment and is available to the machine header as `{wireWatts}` (e.g. `M3 S{wireWatts}`).
  - **Setting it:** power = volts × amps, with the **volts measured by a multimeter across the wire at its two bearings** and the amps read off the supply. Don't use the supply's voltage display: it includes the drop in the leads, clamps and connections, which changes with every setup (lead length, clamp contact, wire length), so the same supply reading can put noticeably different power into the wire. The current is the same everywhere in the circuit, so the supply's ammeter is fine. Matching the power in the wire keeps it at the same temperature, so the kerf table and speeds stay valid between setups. Run the kerf test with the power set the same way.
- **Wire diameter**: set per material, in the material's units: the wire its kerf table, speeds and power were calibrated with. It shows in the material summary and the Export callout, and goes into the G-code as a comment. A different diameter needs a different power for the same temperature and cuts a different kerf, so rerun the kerf test if you change it.

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
