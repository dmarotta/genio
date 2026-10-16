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

The runner always uses `-b --factory-startup --python-exit-code 1`, disables automatic .blend script execution, caps threads (default 4 or available CPUs), and kills Blender after the timeout (default 300 seconds). It makes no connection to an interactive session. Script arguments go after `--`; runner options go before it. Python exceptions fail the run, whereas Blender's default Python exit code is zero! Stdout is a JSON receipt with a log path. Failure prints the last log lines and returns nonzero.

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
node "{{SKILL_DIR}}/scripts/modeller.mjs" init watchtower --target unity [--budget 5000] [--size 4x4x10]
node "{{SKILL_DIR}}/scripts/modeller.mjs" batch watchtower .genio/modeller/watchtower/s01_legs.py .genio/modeller/watchtower/s02_bracing.py .genio/modeller/watchtower/s03_deck.py
node "{{SKILL_DIR}}/scripts/modeller.mjs" step watchtower .genio/modeller/watchtower/s04_railing.py
node "{{SKILL_DIR}}/scripts/modeller.mjs" status watchtower
```

Every step prints JSON: `ok`, `id` (s001, s002...), `caption`, `triangles`, `vertices`, `bounds`, `warnings` and the paths of `sheet` (review PNG), `glb`, `blend` and `receipt`. Exit code 2 means the step failed; 1 means a usage or kernel error.

**Batches.** `batch <model>` takes several scripts in order: their paths, one folder (its `.py` files sorted by name) or a `.json` list (`["s01_body.py", ...]` or `{"steps": [{"script": "s01_body.py", "name": "body"}]}`, paths relative to the file). One Blender runs them back to back; each is a normal step with its own id, receipt, snapshot and GLB, so revert and branch work per step. Each step lands in the live view as soon as its GLB is written (at least 0.6 s apart, so the player sees every change), and its caption shows while it is on its way. Only the last step renders the review sheet (`--every-sheet` renders one per step). `--timeout` is per step. The JSON has `steps` (one entry per landed step), `sheet` and `warnings` of the last one, and on a failure `failure` (as a failed step prints it) and `not_run` (the scripts after it, which did not run). A failing script stops the batch; the steps before it stay.

**The loop:**
1. One step is one idea (body, wheels, wings, cockpit; legs, bracing, deck, roof) with 3 to 15 named parts. Its docstring is one line saying what it adds ("Now adding the roof"), because the player reads it live.
2. Block the model out in batches of 3 to 6 steps. Use single steps for fixes and fine details.
3. After each batch or step, open the `sheet` PNG with your file-read tool. It is 1024 px: 3/4 view top left, front (looking at the model's front, -Y) top right, right side bottom left, top view bottom right. Workbench colours come from your materials.
4. Read `warnings` (a batch's earlier steps have theirs in `steps[].warnings`). Compare the sheet with what you meant: proportions, parts floating or poking through, missing pieces, wrong facing.
5. Fix before you continue. A fix is its own step ("Fixing the ladder rails"), or re-run the last step with `--amend` (it replaces the head, keeping the step count honest).
6. Steering from the player becomes the next step.
7. When you judge the model done, export the head step, place it, commit and report done like any Build (the brief's Modeller delivery says what to commit). In a Unity project the model's `.meta` belongs to the change: never hand-write one; `genio-unity import` generates it, and you commit it with the FBX (if Unity cannot run for you, commit without it and say it appears on the first import). There is no separate review: the player merges as usual. Ask the player something only when it is a real question.

**A step script** starts with a docstring; its first line is the caption the player sees live ("Now adding the roof: corner posts and a pyramid of shingles"). `bpy` and the helpers `p` are preloaded. Build parts with the helpers: a part made again under the same name replaces the old one, so a script can run twice with the same result (idempotent) and the live view can tell parts apart. Reach existing parts with `p.part('Deck planks')`. Prints appear in the receipt's `output`.

```python
"""Raising four tapered timber legs on stone footings"""
wood = p.material('Wood', '#8a5a2b')
stone = p.material('Stone', (0.48, 0.48, 0.5), rough=0.95)
for i, (sx, sy) in enumerate([(1, 1), (-1, 1), (-1, -1), (1, -1)]):
    p.beam(f'Leg {i + 1}', (sx * 1.6, sy * 1.6, 0.0), (sx * 1.2, sy * 1.2, 6.1), 0.28, wood)
    p.cylinder(f'Footing {i + 1}', 0.36, 0.3, (sx * 1.6, sy * 1.6, 0.15), mat=stone, segments=6)
```

**Helpers** (`genio_parts.py`, data API only, so nothing fails a poll in background mode):
- Parts: `box(name, size, loc, rot, mat, col, bevel)`, `cylinder(name, radius, depth, loc, rot, mat, col, segments, radius_top)`, `cone`, `sphere(name, radius, loc, subdiv)`, `plane(name, (x, y))`, `beam(name, a, b, thickness)`, `prism(name, [(x, y)...], depth)` for any outline with thickness, `lathe(name, [(radius, z)...], segments)` for turned shapes (barrels, vases, columns), `jitter(ob, amount, seed)` for rocks and foliage.
- Modifiers, named so re-adding replaces: `bevel(ob, width)`, `array(ob, count, (dx, dy, dz))`, `mirror(ob, axes, about=other)`, `solidify(ob, thickness)`, `subsurf(ob, levels)`, `boolean_cut(ob, cutter)` (the cutter moves to the hidden `Cutters` collection and never ships). The step GLB, counts and checks follow the modifier rule above.
- Materials: `material(name, colour, rough, metal, emission)`; colour is `'#rrggbb'` (sRGB) or a linear `(r, g, b)`. One material per name, reused; it sets the Principled BSDF and the Workbench colour. Names must be real names; `.001` suffixes are refused.
- Structure: `collection('Roof')` groups parts inside `Export`; `parent(child, parent)`; `remove(*names)`; `part(name)`.
- Conventions: metres, Z up, the model stands on z = 0 with its footprint centred on the origin and its front facing -Y. `ground()` and `center()` move the whole model there; `origin_to_base(ob)` puts a part's origin at its foot; `apply_scale(ob)` bakes object scale so bevels stay even. The exporters turn Blender -Y front into Unity +Z (FBX `unity` preset) and glTF +Z (Godot and web GLB); see `p.CONVENTIONS`.
- `cleanup()` drops unused cutters, unlinked objects and orphan meshes and materials; it never touches `Export`. `stats()` gives shipped triangle and vertex counts per part.

**Checks** run on the geometry as it ships after every step: `g.validate()`'s report plus the Modeller's own. They land in the receipt's `checks` and `warnings` and are information for you and the player, never a gate: triangle budget (when `init --budget` set one), ground contact (lowest point at z = 0), footprint centring, scale sanity (and `--size` when given, 25 % tolerance), open or non-manifold parts, inward-facing faces, modifiers held back by shape keys, negative or uneven scale under bevel/solidify, objects outside `Export`, `.001` names, and parts passing through each other. The pass-through check warns only when a part goes deep into another and sticks out again (a post through a roof, a ladder rail inside a leg); every contact, joints included, is listed in `checks.pierces`.

**Kernel operations.** `revert <model> <step>` moves the branch back (later steps stay on disk, off the branch). `branch <model> <name> [--from <step>]` starts a new line of steps and switches to it; `switch <model> <branch>` changes lines. `keep <model> <step>` protects a snapshot from pruning. `materialize <model> [step]` prints a step's `.blend`, rebuilding it if needed; use it to export a deliverable: `node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- export <that .blend> <asset.fbx> --target unity --fmt fbx`.

**Where things live.** Models live in `GENIO_MODELLER_DATA` (the unit's data folder), never the worktree: `manifest.json`, then `steps/<id>/` with `script.py`, `model.blend` (compressed, about 8x smaller), `model.glb`, `sheet.png` and `view.png` (a batch's last step only, unless `--every-sheet`) and `receipt.json`. The last 5 snapshots of every branch are kept; older ones are deleted and rebuilt on demand by replaying the step scripts, so keep scripts deterministic (seeded `jitter`, no clocks or randomness without a seed). Failed steps go to `failed/` with their receipt. Commit step scripts (under `.genio/modeller/<model>/`) and the deliverable, never the step data.

**Failures and the watchdog.** A step that raises, crashes Blender or runs past its timeout (default 60 s, `--timeout`) is stopped; the model stays at its last good step and the snapshot it ran on is verified. The JSON has `kind` (`error`, `crash`, `hang`, `replay`), `error`, `trace` (your script's lines first) and `message`. Fix the script and run it again; never retry it unchanged.

**Blender version.** `init` pins one Blender per model, because GLBs are byte-identical only within a version: `GENIO_BLENDER` when set, else 4.2 LTS when installed (it starts 2-4x faster than 5.x), else the newest 4.2-or-later. `--blender 5.2` or a path picks another; `init <model> --repin` re-pins after an upgrade. A changed or missing pinned binary stops the step with that advice.

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
- For texture baking choose explicit padding for the texture size. `scene.render.bake.margin_type = 'EXTEND'` avoids adjacent-face bleed in workflows that need extended texels; set `margin` deliberately and inspect UV seams/mips.
- Project conventions stay in the project repo: no universal game scale, AO formula, tint masks, LOD policy, naming rules or Unity import settings belong in this skill.
- No MCP/live bridge, .blend thumbnail system, or concept-to-engine pipeline is involved.
