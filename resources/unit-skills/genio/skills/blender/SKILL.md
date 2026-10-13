---
name: blender
description: Batch Blender modelling, mesh cleanup, validation, FBX/GLB export and conversion with explicit engine presets. Uses local Blender, no MCP or interactive session.
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

- `g.export(path, target='unity'|'godot'|'web', fmt='fbx'|'glb')`: both target and format required. Unit scale, Y-up exports; FBX uses -Z forward, FBX_SCALE_ALL, no leaf bones, and **bake_space_transform=False**, including for Unity rigs. GLB includes skinning, animations, normals, UVs and materials without applying modifiers that destroy shape keys. Presets intentionally share coordinate choices; engine import settings remain project-specific.
- `g.apply_transforms()`: apply mesh rotation and scale, preserve location; rejects rigs.
- `g.decimate(ratio)`: destructively apply collapse decimation to export meshes; ratio in (0,1]. Rejects rigs and shape keys. Work on a copy.
- `g.validate(path)` (or no path for current scene): JSON-compatible report of bounds in scene coordinates, dimensions, ground height, origins, unit scale, triangles, meshes/materials, UV presence, unapplied transforms, negative determinant, inconsistent winding, non-manifold edges, loose geometry, degenerate faces and n-gons. Reports base meshes, not evaluated modifiers. Closed-mesh flipped-face counts compare recalculated winding; open surfaces have no provable outside. This is a diagnostic, not an automatic pass/fail gate or artistic judgment.
- `g.preview(path, out)`: 512px Workbench PNG, orthographic 3/4 view framing only the export collection. A .blend must contain that collection; imported FBX/GLB objects become the export collection.
- `g.convert(source, out, target=...)`: FBX to GLB or GLB to FBX. Conversion can lose format-specific shader/animation details; inspect results.

All file-loading helpers replace the current batch scene. They never save changes to their inputs. Run each independently when preserving scene state matters.

```
node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- export source.blend asset.fbx --target unity --fmt fbx
node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- validate asset.fbx --out /scratch/report.json
node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- convert asset.fbx asset.glb --target web
node "{{SKILL_DIR}}/scripts/blender.mjs" --script "{{SKILL_DIR}}/scripts/genio_bpy.py" -- preview asset.glb /scratch/preview.png
```

Other CLI commands: `apply-transforms input.glb cleaned.blend` and `decimate input.glb reduced.blend --ratio 0.5`; all accept `--collection`. Cleanup outputs must be .blend; export afterward with an explicit target. Validation writes pure JSON with `--out`; Blender's log also contains diagnostics.

## Mesh cleanup recipe

Before an Uthana character upload or Unity import, copy the source into scratch, import it, and validate. Check the project's budget and scale convention. Decimate an unrigged copy to that budget; apply rotation/scale before rigging. Inspect UV seams and silhouette, repair winding and loose geometry deliberately, place the origin at ground contact as the project requires, then export with an explicit target. Validate the exported file and inspect a Workbench preview before delivery. Preserve originals and rigs; never decimate an animated character blindly.

## Gotchas

- Blender processes CLI options in order: when writing custom render commands, `-o` must come before `-f`. The runner is for Python scripts; set `scene.render.filepath` before `bpy.ops.render.render(write_still=True)`.
- Workbench background previews need a working graphics driver and show geometry, not final materials. There is no interactive viewport context in batch mode. A render can show both sides and cannot prove correct winding; read validation too.
- For texture baking choose explicit padding for the texture size. `scene.render.bake.margin_type = 'EXTEND'` avoids adjacent-face bleed in workflows that need extended texels; set `margin` deliberately and inspect UV seams/mips.
- Project conventions stay in the project repo: no universal game scale, AO formula, tint masks, LOD policy, naming rules or Unity import settings belong in this skill.
- No MCP/live bridge, .blend thumbnail system, or concept-to-engine pipeline is involved.
