---
name: blender
description: Batch Blender modelling, mesh cleanup, validation, FBX/GLB export and conversion with explicit engine presets, plus Modeller steps (a model built in small reviewed bpy scripts with snapshots, revert and branch). Uses local Blender, no MCP or interactive session.
---

# Blender batch skill

Run a Python build script through the dependency-free Node runner:

```
node "{{SKILL_DIR}}/scripts/blender.mjs" --script build.py --threads 4 --timeout 300 -- arg1 arg2
```

Blender is discovered via `GENIO_BLENDER`, Windows Uninstall registry keys, Program Files/Blender Foundation, then Steam libraries, with PATH as a fallback. Each tier chooses the newest executable version. Set `GENIO_BLENDER` to a full executable path to pin a version. An invalid override fails rather than silently selecting another version. Never use `blender-launcher.exe`: it suppresses useful stdout.

The runner always uses `-b --factory-startup --python-exit-code 1`, disables automatic .blend script execution, caps threads (default 4 or available CPUs), and kills Blender after the timeout (default 300 seconds). It makes no connection to an interactive session. Every run shares one cache of compiled Python (`pyc` in `GENIO_BLENDER_CACHE`, default `genio-blender` in the OS temp folder), so numpy, the add-ons and the helpers are not compiled again on each start. Script arguments go after `--`; runner options go before it. Python exceptions fail the run, whereas Blender's default Python exit code is zero! Stdout is a JSON receipt with a log path. Failure prints the last log lines and returns nonzero.

Logs go to `GENIO_BLENDER_SCRATCH`, supplied by Genio under the unit's data directory. Outside Genio the fallback is the OS temp directory. `--scratch <absolute directory>` can override it; keep scratch outside every project/worktree. Do not put logs or test renders in the project. Deliverable assets go where the project asks.

`--blend source.blend` loads a file before the script. For an asset record, add `--world <worktree> --provenance <output asset>`: this writes `.genio/provenance/<asset>.json` with schema `genio.provenance.v1`, asset hash, script path/hash, input .blend path/hash (null if none), Blender version, script arguments and thread count. Commit the record with the deliverable. Generated .blend files are assets, not implicitly the input .blend.

## Python helpers and CLI

The runner adds its scripts directory to Python's import path. Use `import genio_bpy as g`. Put deliverable meshes, rigs and relevant empties in a collection named `Export`; studio props stay outside it. Helpers accept `collection='OtherName'` explicitly.

- `g.export(path, target='unity'|'godot'|'web', fmt='fbx'|'glb', apply_modifiers=True)`: both target and format required. Unit scale, Y-up exports; FBX uses -Z forward, FBX_SCALE_ALL, no leaf bones, and **bake_space_transform=False**, including for Unity rigs. GLB includes skinning, animations, normals, UVs and materials. Modifiers follow the rule below. Presets intentionally share coordinate choices; engine import settings remain project-specific.
- `g.apply_transforms()`: apply mesh rotation and scale, preserve location; rejects rigs.
- `g.decimate(ratio)`: destructively apply collapse decimation to export meshes; ratio in (0,1]. Rejects rigs and shape keys. Work on a copy.
- `g.validate(path, apply_modifiers=True)` (or no path for current scene): JSON report (`genio.blender-validation.v2`) of the geometry exactly as `export()` ships it: bounds from vertices in scene coordinates, dimensions, ground height, origins, unit scale, triangles and vertices, meshes/materials, UV presence, unapplied transforms, negative determinant, inconsistent winding, non-manifold edges, loose geometry, degenerate faces and n-gons. `base_triangles` gives the unmodified count, and per mesh `modifiers_applied` and `unapplied_modifiers` show what the rule did. Check triangle budgets against `triangles`. Closed-mesh flipped-face counts compare recalculated winding; open surfaces have no provable outside. This is a diagnostic, not an automatic pass/fail gate or artistic judgment.
- `g.preview(path, out, apply_modifiers=True)`: 512px Workbench PNG of the shipped geometry, orthographic 3/4 view framing only the export collection. A .blend must contain that collection; imported FBX/GLB objects become the export collection.
- `g.convert(source, out, target=..., apply_modifiers=True)`: FBX to GLB or GLB to FBX. Conversion can lose format-specific shader/animation details; inspect results.
- `with g.shipped_meshes(objects) as meshes:` maps each mesh object to the mesh datablock it ships as, for custom budget checks. `with g.modifiers_baked(objects):` swaps those meshes in temporarily for custom exporters or renders. Both restore the scene on exit.

**Modifier rule (all presets, validation and preview).** Each mesh ships with its viewport-visible modifiers applied (Bevel, Array, Mirror, Solidify, Subdivision at viewport levels, Boolean and so on), evaluated from the dependency graph. Two exceptions: Armature modifiers always stay live, so rigs export as skinned meshes, and a mesh with shape keys ships its base mesh and morph targets, because applying modifiers would destroy the shape keys. Export prints a stderr warning naming those unapplied modifiers; apply them before adding shape keys. Modifiers are baked on temporary mesh copies; the scene, mesh names and the saved .blend keep their live modifier stacks. `apply_modifiers=False` (CLI `--keep-modifiers`) is the opt-out: every mesh ships and validates as its base mesh. The FBX `use_mesh_modifiers` and glTF `export_apply` switches stay off because they are all-or-nothing; the helpers bake per mesh instead. Verified on Blender 4.2.1 and 5.2.1.

All file-loading helpers replace the current batch scene. They never save changes to their inputs. Run each independently when preserving scene state matters.

```
node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- export source.blend asset.fbx --target unity --fmt fbx
node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- validate asset.fbx --out /scratch/report.json
node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- convert asset.fbx asset.glb --target web
node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- preview asset.glb /scratch/preview.png
```

Other CLI commands: `apply-transforms input.glb cleaned.blend` and `decimate input.glb reduced.blend --ratio 0.5`; all accept `--collection`. `export`, `validate`, `preview` and `convert` accept `--keep-modifiers`. Cleanup outputs must be .blend; export afterward with an explicit target. Validation writes pure JSON with `--out`; Blender's log also contains diagnostics.

## Mesh cleanup recipe

Before an Uthana character upload or Unity import, copy the source into scratch, import it, and validate. Check the project's budget and scale convention. Decimate an unrigged copy to that budget; apply rotation/scale before rigging. Inspect UV seams and silhouette, repair winding and loose geometry deliberately, place the origin at ground contact as the project requires, then export with an explicit target. Validate the exported file and inspect a Workbench preview before delivery. Preserve originals and rigs; never decimate an animated character blindly.

## Modeller steps

A Modeller builds one model in small steps that the player watches live. Each step is a Python file you write; the kernel runs it in headless Blender on the previous step's snapshot. There is no MCP and no live session.

```
node "{{SKILL_DIR}}/scripts/modeller.mjs" init watchtower --target unity [--budget 5000] [--size 4x4x10] [--symmetry x] [--kind building]
node "{{SKILL_DIR}}/scripts/modeller.mjs" step watchtower .genio/modeller/watchtower/s01_legs.py
node "{{SKILL_DIR}}/scripts/modeller.mjs" step watchtower .genio/modeller/watchtower/s02_bracing.py
node "{{SKILL_DIR}}/scripts/modeller.mjs" status watchtower
```

Every step prints JSON: `ok`, `id` (s001, s002...), `caption`, `triangles`, `vertices`, `bounds`, `review` (the text review, below), `warnings` (new since the previous step), `known_warnings` and the paths of `sheet` (review PNG), `glb`, `blend` and `receipt`. Exit code 2 means the step failed; 1 means a usage or kernel error.

**The loop:**
1. One step per script: one idea (body, wheels, wings, cockpit; legs, bracing, deck, roof) with 3 to 15 named parts. Write the script and run its `step` command in the same response (the file write, then the command), never in a separate turn. Once the kit or your helpers carry the shapes, make each step a bigger visible change (about 20 to 40 s of your work), still one script per step, and fold a trivial fix into the next step.
2. Plan first: the layout as data in `lib.py` (`PLAN = p.plan(...)`, **Plan as data** below; `init --kind vehicle|building|prop|weapon|character` starts one for that kind of model, with its step order and sizes). The first step is one small script that blocks out the main mass with simple parts, `p.blockout(PLAN)`, so the player sees the whole model within about a minute. Do not write later steps before it has run; detail comes one step at a time.
3. After each step, read its `review` first (below): it names what changed and the defects the sheet hides or shows only faintly. Open the `sheet` PNG with your file-read tool when you need to see shape, proportions, style or where a defect is. It is 1024 px: 3/4 view top left; front top right (looking at the model's front from -Y: +X right, +Z up); side bottom left (from +X, the model's left side: +Y right, so its front is on the left); top bottom right (a plan view from above: +X right, +Y up, so its front is at the bottom). Each view has its axes in the lower-left corner: X red, Y green, Z blue (an axis pointing at you is left out). Up to 10 parts carry a label beside the model with a line to the part: orange for parts in the review's new items, white for the step's other changes. Workbench colours come from your materials. On a model of 50,000 triangles or more, when the step's changed parts are small against it, the sheet is 1536 px wide: a third column holds two close-ups of those parts, from the two directions that see most of them (whatever stands in front is clipped away), so seams and small details show without a render of your own.
4. Read `warnings`: the step lists only those new since the previous step on the branch, and `known_warnings` counts the earlier ones still standing (the receipt has them all). Compare the review (and the sheet, when you open it) with what you meant: proportions, missing pieces, wrong facing, and every review line you did not intend.
5. Fix before you continue. A fix is its own step ("Fixing the ladder rails"), or re-run the last step with `--amend` (it replaces the head, keeping the step count honest).
6. Steering from the player becomes the next step.
7. When you judge the model done, export the head step, place it, commit and report done like any Build (the brief's Modeller delivery says what to commit). In a Unity project the model's `.meta` belongs to the change: never hand-write one; `genio-unity import` generates it, and you commit it with the FBX (if Unity cannot run for you, commit without it and say it appears on the first import). There is no separate review: the player merges as usual. Ask the player something only when it is a real question.

**References.** When the player attached references (`GENIO_REFERENCES`, listed in your brief's References section), the step JSON's `references` lists the reference images, and the review uses them in one of two ways:
- **Matched by numbers**: an image of one orthographic view, tagged in `references.json` with `"view": "front"` (looking at the front from -Y), `"side"` (from +X, the model's left side) or `"top"` (from above). Every step that renders a sheet renders the model's silhouette from that view and matches it against the image in under a second, in the same Blender run, so you do not open the images after each step. Its review gets a `Reference <view>` line (below) and the step JSON's `match` is a PNG with a cell per view: grey where both are, red reference only, blue model only.
- **Named**: everything else (perspective or 3/4 concept art, sketches, PDFs, notes, models) gets a `References:` line naming it. Compare the sheet with those (open the images beside it: silhouette, proportions, parts, colours), say in a line what still differs, and make that the next step. A reference that is not an image is read once, as your brief says.

How to tag: Genio tags an image whose file name or note names one view (`ship_side.png`, "front view"); tag the others yourself once, before the first step, by adding `"view"` to their entries in `references.json` (in `GENIO_REFERENCES`). Tag only true orthographic views of the whole model, one view per image, as a silhouette, render or screenshot on a plain background (or with a transparent one); never a perspective, a 3/4 view, concept art or a sheet of several views (crop one view out into its own image in your scratch folder first, and point a new entry at it). Add `"span": <metres>` when you know how wide the shape is in the image, left to right (a side view of a 30 m ship: 30); without it the brief's size (`init --size`) scales it, and without that only proportions count (the line says `scaled to fit`). The image may face either way: a mirrored one (a side view with the front to the right, a top view with the front at the top) is turned to fit and the line says so. Do not make reference views yourself: match only what the player attached.

Ask the player (`needs-decision`) only for a real ambiguity, such as references that disagree or a view none of them shows that matters; otherwise follow them and say what you assumed.

**Replays only.** `batch <model>` replays scripts that already exist, in one Blender (restoring work after a revert or on a new branch); never build new steps with it. It takes their paths, one folder (its `.py` files sorted by name) or a `.json` list (`["s01_body.py", ...]` or `{"steps": [{"script": "s01_body.py", "name": "body"}]}`, paths relative to the file). Each is a normal step with its own id and snapshot; only the last renders a sheet (`--every-sheet` renders one per step); `--timeout` is per step. The JSON has `steps`, the last one's `sheet` and `warnings`, and on a failure `failure` and `not_run`. A failing script stops the batch; the steps before it stay.

**API card** (enough to start: never read `genio_step.py`, `genio_parts.py` or `modeller.mjs`):
- A step script runs in headless Blender on the previous step's scene with `bpy` and `p` preloaded. Line 1 is a one-line docstring caption in plain words; the player reads it live.
- After each step read its `review` first: what changed, then problems by part name, each once, then as a count; `p.intended(a, b)` drops an overlap you mean. Open the `sheet` only for shape, proportions and style.
- Write each helper of yours once, in `lib.py` beside the step scripts: it runs before every step, so its functions are globals there.
- Plan first, in `lib.py` (below; `init --kind` writes one to adapt): step 1 is `p.blockout(PLAN)`, every part; later steps rebuild parts by name at `PLAN[name].at`; the review's `Plan:` line names parts off their plan.
- Metres, Z up, the model stands on z = 0 with its footprint centred on the origin and its front facing -Y (its left side is +X).
- A part made again under the same name replaces the old one, so a script can run twice. Part helpers return the object and take `mat=` and `col=`; `rot` is Euler radians.
- Parts: `p.box(name, (sx, sy, sz), loc, rot, mat, bevel=0.0)` centred on loc; `p.cylinder(name, radius, depth, loc, rot, mat)` along local Z; `p.sphere(name, radius, loc, mat)`; `p.beam(name, a, b, thickness, mat)`; `p.prism(name, [(x, y), ...], depth)`; `p.lathe(name, [(r, z), ...], segments)`; `p.loft(name, sections)`; `p.jitter(ob, amount, seed)`.
- Hard-surface kit, smooth with sharp edges by angle: `p.mesh(name, verts, faces)`; `p.revolve(name, pieces, segments)` (pieces of (r, z), crisp joins); `p.sweep(name, path, section)`; `p.hull(name, stations)` ((y, width, height, z) each); `p.capsule(name, a, b, radius)`; `p.smooth(ob)`; `p.panel_lines(ob, size)`; `p.window_rows(name, part, rows)`; `p.greebles(name, part, region)`; points: `p.curve`, `p.circle`, `p.rect`.
- Materials: `p.material(name, '#rrggbb', rough=0.8, metal=0.0, emission=0.0, preset=None)` ('brushed', 'painted', 'glass', 'emissive', 'rubber'), one per name.
- Modifiers, named so adding one again replaces it: `p.bevel(ob, width)`, `p.array(ob, count, (dx, dy, dz))`, `p.mirror(ob)`, `p.solidify(ob, thickness)`, `p.subsurf(ob, levels)`, `p.boolean_cut(ob, cutter)` (the cutter never ships); `p.freeze(*parts)` applies them for good.
- High-poly: build density directly, or `p.subsurf` only low-poly cages; freeze each finished part; bake once, at the end.
- Placing: `p.join(name, parts)`; `p.drop(ob, on=None)` onto the ground or the part `on`; `p.mirror_pair(ob)` (`Arm L` makes `Arm R`); `p.ring(ob, count, center, axis='Z')` copies round an axis.
- Structure: `p.collection('Legs')` (a group inside `Export`, passed as `col=`), `p.parent(child, parent)`, `p.part(name)`, `p.remove(*names)`, `p.ground()`, `p.center()`.
- Paint: `p.uv_atlas()` once, `p.camo(mat, 'red'|'woodland'|'desert'|'digital')`, `p.weathering(mat, wear=0.8, dirt=1.0)`, then `p.bake_maps(size=1024)`.

```python
# lib.py
PLAN = p.plan({'Hull': dict(at=(0, 0, 0.75), size=(1.8, 4.2, 0.7)),
               'Wheel L': dict(at=(1.05, -1.3, 0.4), size=(0.3, 0.8, 0.8), shape='cylinder', mirror=True)})
# s01_blockout.py
"""Blocking out the main mass: the hull and its wheels"""
p.blockout(PLAN)
```

**Shared helpers.** `lib.py` sits beside the step scripts (`.genio/modeller/<model>/lib.py`) and is committed with them. The kernel copies it into each step as the step runs (`steps/<id>/lib.py`, the step JSON's `lib`), so a later edit never changes an earlier step: revert, branch and replays run every step after the lib it ran with. An error inside it names `lib.py` and its line in `trace`. Keep it to the plan, constants (materials, profiles) and helper functions; parts belong in steps.
- `p.join(name, parts, col=None)`: parts or names; modifiers are applied, materials kept; the first part's origin, rotation and parent; the parts' children move to the new part without moving.
- `p.drop(ob, on=None, gap=0.0)` moves the part and its children straight down or up and returns the move; `on` is a part, a name or a list, and the part lands on the highest point of `on` under it.
- `p.mirror_pair(ob, name=None)` is a real copy with its children, mirrored across its parent's own x = 0 when it has a parent. Names swap `L`/`R` and `Left`/`Right` as words; pass `name` for others. Modifiers come along; boolean cuts do not, so cut the twin too.
- `p.ring(ob, count, center=(0, 0, 0), axis='Z', arc=360.0, join=True)`: build the first copy where it goes, then ring it; a full circle spaces the copies evenly; a smaller `arc` (degrees) puts the last at its end. `join=False` keeps `name_1` ... `name_N`. Children are not copied.
- `p.loft(name, sections, loc, rot, mat, col, closed=True, caps=True, smooth=False)`: sections of (x, y, z) points, all of one count (a section of one point is a tip); `caps` fills the end loops; `closed=False` skins open lines into a sheet (a sail, a roof skin).

**Plan as data.** Write the model's layout down before any geometry, in `lib.py`, so every step reads its numbers from one place and the review can check the parts against it:
```python
HULL = p.material('Hull', '#c9ccd1', preset='painted')
PLAN = p.plan({
    'Saucer': dict(at=(0, -8.3, 5.85), size=(13.4, 13.4, 1.32), shape='disc', mat=HULL),
    'Engineering hull': dict(at=(0, 3.07, 1.56), size=(3.12, 13.07, 3.12), shape='capsule'),
    'Nacelle L': dict(at=(3.5, 7.2, 7.06), size=(1.24, 15.6, 1.24), shape='capsule', mirror=True),
    'Neck': dict(ends=((0, -3.6, 5.78), (0, 0.15, 2.81)), size=(0.82, 3.3), level=True),
    'Pylon L': dict(between=('Engineering hull', 'Nacelle L'), size=0.25, mirror=True),
})
```
- Each part is `at` (its centre) and `size` (x, y, z) in the model's final place (standing on z = 0, centred, front to -Y), with a `shape`: `box` (default), `cylinder`, `disc`, `sphere`, `capsule`, `cone` or `wedge` (a gable whose ridge runs along `axis`). Round and long shapes run along `axis`, by default the size unlike the other two (a wheel's width, a nacelle's length; z for a disc).
- A part between two points: `ends=((x, y, z), (x, y, z))`, or `between=('A', 'B')`, two parts planned before it (from where the line between their centres leaves one to where it enters the other, sunk half its thickness into each); `size` is then its thickness, one number or (width, height); shape `beam` (default), `capsule`, `cylinder` or `cone`. `level=True` keeps its sections level, as `p.sweep(..., level=True)` does: a neck, pylon or leg swept back.
- `mirror=True` plans the twin across x = 0 too (`Nacelle L` plans `Nacelle R`); `mat` is a material (or a material's name) for its blockout.
- It returns the plan: `PLAN['Nacelle L'].at`, `.size`, `.box` (min, max), `.shape`, `.axis`, `.ends`; `PLAN.box` is the whole model's. `p.blockout(PLAN)` builds every part (or `p.blockout(PLAN, 'Neck')` the named ones) as its simple shape, named as planned, in the plan's `mat` or one grey `Blockout`; each later step replaces a part by name.
- Since `lib.py` runs before every step, the scene keeps the plan as the lib last wrote it, and the review's `Plan` line compares every built part with it. Change the plan in `lib.py` when the design changes; fix the part when it strayed.
- `init --kind vehicle|building|prop|weapon|character` writes the kind's template as the model's `lib.py` (beside the step scripts, never over one that is there): materials and a plan of a typical model of that kind (a car, a cottage, a barrel, a rifle, a six-heads-tall character in an A-pose), whose blockout reviews clean, and in its docstring the order of steps, the kit helpers to use, the triangle budgets per style and typical sizes. Change the parts and numbers to the brief's. A vehicle or character model also gets `--symmetry x` unless you give one.

**Hard-surface kit.** Generic helpers for realistic and high-poly parts, so a step calls them instead of writing its own geometry code. The kit's parts shade smooth, with edges sharper than 35 degrees kept crisp (`smooth=` takes another angle, or None for flat), and replace a part of the same name.
- `p.mesh(name, verts, faces, loc, rot, mat, col, smooth=35)`: a part from raw geometry, `faces` of three or more vertex indices in any winding (made consistent, outward on a closed shell). `p.from_bmesh(name, bm, ...)` takes a bmesh of your own when lists are not enough.
- `p.smooth(ob, angle=35)` re-shades any part (None: flat); `p.weighted_normals(ob)` adds a Weighted Normal modifier, so large faces stay flat next to bevels.
- `p.curve(points, n=4, closed=False)`: a smooth line through points of any length ((x, y, z), (r, z), stations), `n` points per span, every given point kept. `p.circle(radius, n=32, center=(0, 0))` (a 3D `center` gives a ring at its height) and `p.rect(width, height, radius=0, per=4)` make outlines and rings.
- `p.revolve(name, pieces, segments=64, loc, rot, mat, col, n=4)`: a surface of revolution round local Z from profile pieces of (radius, z) points (one list for a single piece), each smoothed through its points; joins between pieces stay crisp (a rim, a step); points at radius 0 close the ends. Saucers, domes, hulls, bottles, nozzles.
- `p.sweep(name, path, section, scale=None, loc, rot, mat, col, n=4, closed=False, caps=True, up=(0, 0, 1), level=False)`: a tube along a path of (x, y, z) points through a closed (x, y) outline, or one outline per path point (one count) to change shape, `scale` per point a number or (sx, sy) (0 makes a tip). The section's x runs to the path's right and y to its up, turning without a twist; `level=True` keeps the sections level (x along world X, y along Y) for a neck or pylon swept back. `closed=True` makes a ring. Pipes, cables, rails, struts, fuselages.
- `p.hull(name, stations, section='round', points=24, loc, rot, mat, col, n=4, caps=True)`: stations along Y, each (y, width, height, z), smoothed through; sections `'round'`, `'box'`, `'deck'` (flat on top, round below) or your own outline in a 1 x 1 square, and a fifth station item gives that station its own. Width or height 0 makes a point (a bow, a tail cone). Car bodies, boat hulls, fuselages.
- `p.capsule(name, a, b, radius, ends='round', segments=24)`: from point a to point b, tips included; `radius` one number or (at a, at b); `ends` `'round'`, `'flat'` or `'point'`, or one per end. Nacelles, tanks, limbs, pods.
- `p.panel_lines(ob, size=0.8, pattern='grid', gap=0.012, depth=0.006, region=None, mat=None, bake_only=False, strength=0.6)`: plates about `size` metres with recessed seams between them, the seam strips in `mat`, every seam edge sharp, the part still closed. On parts from `p.revolve`, `p.sweep`, `p.hull` and `p.capsule` the plates follow the surface: `'grid'` rows along each piece or station span and columns around (columns halve towards a pole and line up across rows), `'radial'` columns only, `'concentric'` rows only, `'stations'` a seam at each joint; rows follow the surface's own loops, so give it loops at least as close as the plates. On other parts `'grid'` cuts a grid in the part's own space (a box's sides split into plates). `region(point)` (a face centre in the part's space) picks where. `bake_only=True` adds no triangles: it marks the seams on the part's material, and `p.bake_maps` bakes them as darker (`strength`), rougher lines. Once per part; it returns the number of plates.
- `p.window_rows(name, part, rows, size=(0.4, 0.25), spacing=None, mat=None, depth=0.04, reach=None, closed=False)`: windows along rows of (x, y, z) points near a part's surface (`p.circle` round a 3D centre for a ring), one every `spacing` (twice the width), on the surface nearest the row, facing out and half sunk, as one part in an emissive `Window light` unless `mat` says otherwise. Points with no surface within `reach` (four window widths) get none.
- `p.greebles(name, part, region=None, density=20, sizes=(0.05, 0.25), height=(0.2, 0.8), shapes=('box', 'cylinder'), seed=0, mat=None, budget=4000)`: small boxes and cylinders standing on a part's surface where `region(point)` (a world point) says, about `density` per m², turned at random, seeded, within `budget` triangles, as one part in the part's own material.
- Material presets: `'brushed'` metal (anisotropic), `'painted'` (a clear coat), `'glass'` (transmission), `'emissive'` (glows, strength 4), `'rubber'`; `rough`, `metal` and `emission` given as well win. Making a material again without a preset clears it. `p.bake_maps` bakes colour, roughness and metallic only.

**High-poly models** (about 100k triangles and more). Every step is a fresh Blender that opens the previous snapshot, and a snapshot keeps no modifier results, so each step evaluates every live modifier again: a level-1 Subdivision on every part of a 105k-triangle starship cost about 6 s of loading per step, measured.
- Build the density directly (`p.revolve` with more segments, `p.hull` or `p.sweep` with a larger `n`, `p.mesh` from your own vertices), or put `p.subsurf` only on low-poly cages, never on dense meshes.
- `p.freeze(*parts)` applies a part's modifiers (Subdivision, Bevel, Boolean, Mirror, Array) for good once it is final: it ships exactly the same shape, and later steps skip them. With no parts it freezes every part. Armature modifiers stay; a part with shape keys keeps its stack. The snapshot grows (1.5 to 6.8 MB on the starship) and the step after loads in well under a second instead. A step whose snapshot's live modifiers take seconds to load and evaluate says so in its warnings.
- The plan and the kit carry most of the work: profiles, stations and paths as constants in `lib.py` beside the plan, the surfaces from `p.revolve`, `p.sweep`, `p.hull` and `p.capsule`, the seams from `p.panel_lines` (`bake_only=True` when triangles are short), with no geometry code of your own.
- Paint and `p.bake_maps` once, at the end, on frozen parts: the bake costs about the same at any density (11 s at 2048 px for 105k and 423k triangles).
- A step that adds live modifiers to a dense model, or freezes one, can take longer than the 60 s watchdog: run it with `--timeout 180`.
- To see fine detail of what a step changed, open its sheet: from 50,000 triangles it has close-ups of the changed parts (the loop, step 3). Do not write a camera or render of your own for that.

**Beyond the card.** The helpers use the data API only, so nothing fails a poll in background mode. Prints appear in the receipt's `output`. More parts: `p.cone(name, radius, depth, loc, rot, mat)` and `p.plane(name, (x, y), loc, rot, mat)` (an open surface: add `solidify` for thickness); `p.cylinder` takes `segments=16` and `radius_top=None` (a taper; 0 makes a cone); `p.sphere` takes `subdiv=2` (1 is a faceted low-poly ball); `p.prism` extrudes its counter-clockwise outline along local Z, centred, and takes `loc, rot, mat` like `p.lathe` and `p.loft`. `p.origin_to_base(ob)` puts a part's origin at the bottom centre of its geometry without moving it. `p.bevel(ob, width, segments=2, angle=30)` rounds edges where faces meet at more than `angle` degrees; `p.mirror(ob, axes=(True, False, False), about=other)` is a Mirror modifier, across another object's axes with `about` (`p.mirror_pair` makes a named twin instead). A colour can also be a linear `(r, g, b)`; a material sets the Principled BSDF and the Workbench colour, and `.001` names are refused. `boolean_cut` moves the cutter to the hidden `Cutters` collection. The step GLB, counts and checks follow the modifier rule above. `jitter` is seeded, for rocks and foliage; `apply_scale` keeps bevels even; `cleanup()` drops unused cutters, unlinked objects and orphan meshes and materials, never touching `Export`; `stats()` counts shipped triangles and vertices per part. The exporters turn Blender -Y front into Unity +Z (FBX `unity` preset) and glTF +Z (Godot and web GLB); see `p.CONVENTIONS`.

**Paint and bake.** Paint is one step, after the shape is final:
```python
"""Painting it: woodland camouflage with worn edges and mud, baked into one 1024 px texture set"""
p.uv_atlas()
p.camo('Armor', 'woodland')
p.weathering('Gun metal', wear=0.8, dirt=0.7, wear_color='#9a9da2')
p.bake_maps(size=1024)
```
- `p.uv_atlas(objects=None, angle=66, margin=0.003)` gives every part one shared, non-overlapping UV map. It applies their modifiers first (shape-keyed parts keep theirs), so array and mirror copies get their own texels. It returns the share of the atlas in use.
- `p.camo(mat, palette='woodland', scale=None, panel_lines=0.6, wear=0.8, dirt=1.0, seed=0, pattern=None)` paints a material (or material name) with warped noise patches, grain and panel lines, plus `weathering()` unless `wear` and `dirt` are 0. Palettes are in `p.CAMO`: `red`, `woodland`, `desert`, `arctic`, `urban` and `digital` (pixel pattern). Your own `['#ground', '#patch', ...]` (2 to 5 colours) also works, and `pattern='digital'` pixelates any palette. `scale=None` fits the pattern to the model's height (1.0 suits an 8.5 m model); `seed` moves the patches.
- `p.weathering(mat, wear=0.8, dirt=1.0, scale=None, panel_lines=0.0, wear_color='#8c8780', bare_rough=0.35, bare_metal=0.85)` works on the material's own colour, roughness and metallic (set them with `p.material` first), or on its camo. It adds worn and scratched edges showing bare metal, crevice grime (AO), mud low down and rain streaks.
- Both presets are procedural nodes feeding the material's Principled BSDF, laid out in scene coordinates (metres from the origin). Calling one again replaces it, so a re-run step does not stack paint. Only Cycles evaluates the edge and grime nodes, so the review sheet shows the plain material colour until the bake.
- `p.bake_maps(objects=None, size=1024, samples=8, maps=('basecolor', 'roughmetal'), margin=None, material='Baked', gpu=False, out_dir=None)` bakes whatever each part's material feeds its Principled BSDF into one texture set: base colour, plus roughness (G) and metallic (B). That means the presets, or any node graph of your own. It copies the parts as they ship, joins the copies into one temporary mesh and bakes once per map: never one bake per part. Meanwhile the originals are hidden from render, so AO and bevel rays see the same geometry; the copy is then deleted. Object coordinates (Texture Coordinate > Object) still read each part's own space.
- After the bake, the maps are saved as PNGs (default: the `bake` folder in the Modeller data folder) and packed into the .blend and GLB. The parts get one shared image-textured material named `material`; with `material=None`, each part's own materials are rewired to the textures instead. Emission is not baked.
- The kernel starts Blender on every core for a step (or replay) that calls `p.bake_maps`; any other step runs on 4. `samples=8` looks the same as 32 on this paint. `gpu=True` tries OptiX, CUDA, HIP, oneAPI or Metal and falls back to the CPU; it stays off by default because it competes with the player's game or editor. A GPU bake with shader features new to the machine first compiles kernels: from 15 s to over 2 min, measured. Run such a step with `--timeout 300`.
- It returns, prints and lists in the step JSON's `bakes` the parts, size, samples, device, threads and seconds per map. Once parts carry baked textures, the review sheet shows them.
- Measured on an 88-part benchmark model (2048 px, 8 spp, 16 threads, Blender 4.2): 13 to 15 s of baking, about 20 s for the whole step, against 375 s for its hand-written per-part bake. At 1024 px the bake takes about 2 s.

**Text review.** Every step's `review` is a few short lines, made from the shipped geometry in the same Blender run (no rendering, deterministic). It is incremental: only pairs of parts with a part changed since the previous step (by an exact comparison of its shipped geometry) are examined, and the other pairs keep that step's results, so its cost follows what changed (0.3 s at 105k triangles, 1.1 s at 423k, one part changed). Every tenth step, a step whose model changed size and `materialize` examine every pair. The first line is always there; each other line appears only when it has something to say:
```
Changes: 2 added (Bridge deck, Garden bed), 1 moved (Well), 1 removed (Spare)
Plan: Nacelle L at x 2.5 (plan 3.5); Neck 2.1 m tall (plan 3 m); not built: Pylon L
Floating: Lamp (0.32 m from Top)
Deep overlap: Roof / Roof post 1 (0.46 m inside, 0.43 m out); Block / Top (40 % of Block inside)
Z-fighting: Decal / Top (0.09 m² at 0, -0.2, 1)
Symmetry: Handle L has no Handle R; Leg front R is 0.05 m off the mirror of Leg front L; no mirror twin in x: Lamp
Size: 24.6 m long (brief 30 m, 82 %)
Triangles: 105k of 400k; Saucer 52k (50 %); Bridge module 23k (22 %)
Materials: none on Flag; Mast wood and Wood look the same
Bake: paint on Wood ships only after p.bake_maps; no UVs on Lamp (p.uv_atlas)
Reference side: 77 % overlap; Neck not in the reference (97 % outside); Saucer 12 % too short (1.55 m); Engineering hull 0.49 m too high
Reference top: 79 % overlap; missing 2.77 x 15.59 m at x 1.39..4.16, y -0.58..15.01
```
- **Each item once.** A line names an item (a pair, a part, a group) the first time it shows it, and again only when its numbers move (by more than 1 % of the model, or 5 % of the length; 25 % of an area; 5 points of a share). While it stands as shown, it is a count: `Deep overlap: Gun ports L / Hull (0.75 m inside, 0.2 m out); 3 known` names the new pair and counts the three you read before, and `Deep overlap: 4 known` says nothing new. "Before" is the previous step on the branch (an amend compares with the replaced step's parent). Only new items get an orange label on the sheet. The receipt's `review_full` names every item, and `materialize` returns every item.
- **`p.intended(a, b, ...)`** marks parts as meant to overlap or share faces (a keel through the hull, a decal on a panel): every pair among them leaves the Deep overlap and Z-fighting lines for good, also in `materialize`. The model keeps the marks, so later steps and replays have them. Mark only what you mean; anything else is worth a fix.
- `Changes` compares each part's name, triangles and box with the previous step on the branch: `changed` means a new shape or size, `moved` the same box elsewhere.
- `Plan` (with a `p.plan` in `lib.py`): a built part whose box is off its plan entry's, its centre more than 2 % of the plan's size away on an axis (`at x 2.5 (plan 3.5)`) or a size more than 10 % off (at least that 2 %), in plan order; then the planned parts the model does not have (`not built`). Parts the plan does not name (windows, greebles, details) are not checked.
- `Floating`: parts (or groups of parts touching only each other) with no chain of contacts down to a part at the model's lowest point, with the gap to the nearest other part. A part inside another touches it.
- `Deep overlap`: a part deep into another and out again (3 % of the model's size in, 1 % out: a post through a roof), or a closed part with a third or more of its volume sunk into another, the overlap at least 3 % of the model thick every way (`hidden inside` when all of it is). Joints, crossing timbers, posts in a socket and thin slabs laid into each other stay quiet; every contact is still in the receipt's `checks.pierces`.
- `Z-fighting`: faces of two parts facing the same way in one plane (within 0.02 % of the model's size) that overlap by more than (1 % of the size)², with the shared area and its centre. Faces meeting back to back (a box resting on another) are not z-fighting.
- `Symmetry`: a part named with a side (`Arm L`, `Left wing`) whose twin is missing, or is not its mirror across x = 0 (across their parent's x = 0 when they share one) within 1 % of the size. With `init --symmetry x` (or `y`, front to back; `none` clears it), also parts on one side with no mirror twin and parts across the centre whose box is off centre.
- `Size` (with `init --size`): each axis more than 5 % off the brief, wide (x), long (y) or tall (z), with the share it reaches.
- `Triangles`: past half the budget (`init --budget`), or on a model of 20,000 triangles or more with one part holding 40 % of them: the total, then the parts holding a fifth or more.
- `Materials`: parts without a material (or with an empty slot), and materials on shipped parts that look the same (colour, roughness, metallic, emission and paint presets; a node graph of your own is left out).
- `Bake`: paint (`p.camo`, `p.weathering` or your own nodes into the Principled BSDF) that ships only once `p.bake_maps` has baked it, and parts without UVs when there is paint to bake or image textures on the model.
- `Reference <view>` (with a reference tagged that view, **References** above; `Reference top (plan.png)` when two share a view): the overlap of the model's silhouette and the reference's, then by part name, largest first: a part too wide, narrow, long, short or tall against it (per cent of the part and metres), too high, low, far forward, back or to one side, or one edge short of or past the reference when only that edge forms the outline; `missing W x H m at ...` for reference shape with no part there (a part not built yet), with its place in the model's metres; `not in the reference` for a part mostly where the reference has nothing. Each part is fitted to the reference by moving its box edges, biggest parts first, after the image is slid to where the parts agree, so one misplaced part does not shift the others; fix the largest differences first and expect small parts sitting on a changed big one to move with it. Numbers are as good as the image: a drawing that is not a true orthographic view, or views that disagree, give lines to weigh, not to obey. Open the `match` PNG when a line is unclear.
- At most three items per line (four for a `Reference` line, the overlap first), then `and N more`; the receipt keeps the lines and each part's `box`. It is information, never a gate: an intended overlap or a hanging lamp can stay.

**Checks** run on the geometry as it ships after every step: `g.validate()`'s report plus the Modeller's own. They land in the receipt's `checks` and `warnings` and are information for you and the player, never a gate: ground contact (lowest point at z = 0), footprint centring, scale sanity, open or non-manifold parts, inward-facing faces, modifiers held back by shape keys, negative or uneven scale under bevel/solidify, objects outside `Export` and `.001` names. The triangle budget and the brief's size are the review's `Triangles` and `Size` lines, and parts passing through each other its `Deep overlap` line, not warnings. The pass-through and z-fighting checks each have a work budget; one that stops early says so in the warnings, and its list is incomplete.

**Kernel operations.** `revert <model> <step>` moves the branch back (later steps stay on disk, off the branch). `branch <model> <name> [--from <step>]` starts a new line of steps and switches to it; `switch <model> <branch>` changes lines. `keep <model> <step>` protects a snapshot from pruning. `materialize <model> [step]` prints a step's `.blend`, rebuilding it if needed, and its `review` (every item) and `warnings` from a check of every pair (run there once when the step's own check was incremental): read them, then use the `.blend` to export a deliverable: `node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- export <that .blend> <asset.fbx> --target unity --fmt fbx`. `report <model>` sums up the model's run for recons and benchmarks (you need it only when a brief asks): wall time from `init` and to the first step, steps, runs, amends, reruns and failures, your time between runs and Blender's per run (median, 90th percentile, sum), Blender's phases and checks, script and lib sizes, triangles against the budget, the review's new and known items, the head's open review lines and steps killed after landing.

**Where things live.** Models live in `GENIO_MODELLER_DATA` (the unit's data folder), never the worktree: `manifest.json`, then `steps/<id>/` with `script.py`, `lib.py` (when the step had one), `model.blend` (compressed, about 8x smaller), `model.glb`, `sheet.png`, `view.png` and, with tagged references, `match.png` (a batch's last step only, unless `--every-sheet`) and `receipt.json`. Each receipt also measures its run: `agent_ms` (your time since the kernel returned the run before, or since `init`; a gap past 10 minutes is marked `agent_gap` and left out of the report), `script_bytes`, `lib_bytes`, `lib_changed`, `amend`, `rerun_of` (the run before had the same step name), `phases_ms` (think, the step's Blender time, and of it export, checks and sheet), `timings_ms` (Blender's own phases, from `start`), `checks_ms` (each check), `review_new` and `review_known` per line, `warnings_new` and, when Blender stopped after the step landed, `killed_after_landing`. The last 5 snapshots of every branch are kept; older ones are deleted and rebuilt on demand by replaying the step scripts, so keep scripts deterministic (seeded `jitter`, no clocks or randomness without a seed). Failed steps go to `failed/` with their receipt. Commit step scripts and `lib.py` (under `.genio/modeller/<model>/`) and the deliverable, never the step data.

**Failures and the watchdog.** The player sees a step as soon as its GLB is exported; the snapshot, then the checks and the sheet come after, and the command returns when they are done. A sheet that fails is a warning (the step stays, without a sheet); Blender stopping after the export keeps the step too, with a warning, and its snapshot once saved (right after the export), so the next step replays its script only if the snapshot is missing. The sheet renders the shipped meshes, so live modifiers are not evaluated again for it. A step that raises, crashes Blender or runs past its timeout (default 60 s, `--timeout`) before its export is stopped; the model stays at its last good step and the snapshot it ran on is verified. The JSON has `kind` (`error`, `crash`, `hang`, `replay`), `error`, `trace` (your script's lines first) and `message`. Fix the script and run it again; never retry it unchanged.

**Blender version.** `init` pins one Blender per model, because GLBs are byte-identical only within a version: `GENIO_BLENDER` when set, else 4.2 LTS when installed (a headless start with the step runner's imports takes about 1.0 s against 1.5 s for 5.2, measured), else the newest 4.2-or-later. `--blender 5.2` or a path picks another; `init <model> --repin` re-pins after an upgrade. A changed or missing pinned binary stops the step with that advice. `init` reads the installed Blenders from a list it keeps for a week and searches again when a listed binary changed or a new one is in Program Files, Steam or PATH; `--repin` always searches again (use it after installing a Blender elsewhere). On a Blender not used before, `init` also starts a short background run that fills the compiled-Python cache, so the first step starts warm.

**4.2 vs 5.2 traps** (measured on 4.2.1 and 5.2.1). The helpers already avoid them; mind them in raw bpy:

| Idiom | 4.2 | 5.2 | Use instead |
|---|---|---|---|
| `scene.render.engine = 'BLENDER_EEVEE'` | error | ok | `p.EEVEE` (4.2 needs `BLENDER_EEVEE_NEXT`) |
| `scene.render.engine = 'BLENDER_EEVEE_NEXT'` | ok | error | `p.EEVEE` |
| `scene.eevee.use_bloom`, `use_ssr` | ok | error | drop them |
| `mat.shadow_method` | ok | error | omit |
| `mat.use_nodes = True` | needed | DeprecationWarning (gone in 6.0) | `if mat.node_tree is None: mat.use_nodes = True` |
| new material has a node tree | no | yes | as above |
| BSDF `inputs['Specular']`, `['Emission']` | error | error | `'Specular IOR Level'`, `'Emission Color'` |
| `mesh.use_auto_smooth`, `calc_normals()`, `calc_normals_split()` | error | error | `mesh.shade_smooth()`, `shade_auto_smooth()` |
| `shade_smooth(use_auto_smooth=True)` | error | error | `bpy.ops.object.shade_smooth_by_angle()` |
| operator dict override `op({'active_object': o})` | error | error | `with bpy.context.temp_override(...)` |
| `create_cone(diameter1=...)` | error | error | `radius1`, `radius2` |
| `bpy.ops.export_mesh.stl` | missing | missing | `bpy.ops.wm.stl_export` |
| `bpy.ops.wm.collada_export` | ok | missing | glTF or FBX |
| `scene.node_tree` (compositor) | ok | missing | `scene.compositing_node_group` (5.x) |
| `bpy.ops.ed.undo()` in background | error | error | revert to a step |
| glTF `export_colors=` | missing | missing | `export_vertex_color` |

`bpy.app.timers` never fire in background mode: do the work inline. `DeprecationWarning`s raised by a step show up in its `warnings`.

## Gotchas

- Blender processes CLI options in order: when writing custom render commands, `-o` must come before `-f`. The runner is for Python scripts; set `scene.render.filepath` before `bpy.ops.render.render(write_still=True)`.
- Workbench background previews need a working graphics driver and show geometry, not final materials. There is no interactive viewport context in batch mode. A render can show both sides and cannot prove correct winding; read validation too.
- Low-poly web models (a few thousand triangles) take 1024 px textures: about a third of the 2048 px file size, and enough texel density at that triangle count. Use 2048 px only when the mission asks for it.
- For texture baking choose explicit padding for the texture size. `scene.render.bake.margin_type = 'EXTEND'` avoids adjacent-face bleed in workflows that need extended texels; set `margin` deliberately and inspect UV seams/mips.
- Project conventions stay in the project repo: no universal game scale, AO formula, tint masks, LOD policy, naming rules or Unity import settings belong in this skill.
- No MCP/live bridge, .blend thumbnail system, or concept-to-engine pipeline is involved.
