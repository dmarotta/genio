# Art Direction

## Summary

A fully 3D stylized low-poly world built for city-builder readability, fast asset production and strong large-scale screenshots: clean, cohesive, colorful and substantial, never miniature, toy-like or overly cartoonish.

The style is **simple sculptural geometry + broad solid-color regions + restrained baked AO + soft daylight**. Warm stone and timber, cool slate roofs, muted metal trim and controlled accents give the world one identity. Synty-style assets are a reference for geometric economy; we add soft depth at intersections, broad lighting gradients and gentle contact shadows, and avoid a flat or glossy plastic look.

The Asterhold, Ironhearth and Greenbough studies below set the direction for buildings and vegetation.

## Geometry

Prioritize silhouette, proportion, large masses, readable layering, recognizable function and hierarchy. Build from boxes, bevelled boxes, low-sided cylinders, simple arches, chunky pillars, broad stairs, battlements, large roofs and recesses, clear towers and buttresses. Avoid micro-detail, modelled brickwork, tiny shingles, dense engraving and needless subdivision.

Fix a weak building through form, not surface noise: add a recess, buttress, porch, roof break or height change, and keep space between important forms. Connections must look deliberate: beams meet cleanly, posts carry roofs, stairs reach landings, windows clear overhangs. Use symmetry for formal joins and asymmetry where it improves the composition.

Modest bevels go where they help edges catch daylight, not everywhere.

## Function and liveliness

Production buildings look occupied and useful, with a few work stations and tools that survive the gameplay camera. The blacksmith sets the example: hearth, anvil, grindstone, hanging tools, bench, bellows, fuel bin, quench vat, a hot billet and a small fire. Group props by use, keep entrances and the defining activity visible, and connect hanging objects to supports. Never fill space with unrelated blocks, repeated crates or clutter.

Chimneys smoke in spells so a district reads as lived in, not industrial: most are cold at any moment, and the rest send up short, thin wisps of faceted puffs that shrink away rather than fade. Wind nudges plumes to lean, not stream.

## Materials and textures

Materials read as solid color, with changes only between purposeful regions; no random per-face variation. One atlas material can hold many regions; a separate emissive material suits a crystal or hearth. Use constant roughness and metallic values.

Textures carry flat color and baked AO only: no photo textures, grunge, scratches, dirt noise, detailed procedural materials, or normal, bump or displacement maps.

### Reference palette

Solid sRGB source colors before AO and lighting; a family, not a requirement for every asset.

| Role | Color | Use |
|---|---|---|
| Warm limestone | `#CBBF9F` | Main walls, arches, pale masses |
| Cool grey stone | `#8B9690` | Foundations, retaining walls, bands |
| Blue slate | `#344F60` | Roofs, dark recesses, stylized iron |
| Muted bronze | `#B79757` | Select trim and focal points |
| Warm timber | `#776048` | Framing, tools, trunks |
| Foliage greens | `#627D4D`, `#779354`, `#91AA67` | Broad canopy regions |
| Cyan Aether | `#53D9D1` | Magical crystals |
| Ember orange | `#EF8B36` | Small hearth and hot-metal accents |

Stone and roofs carry the architecture; keep gold selective, foliage cohesive and bright magic or fire colors local.

### Ambient occlusion

Bake soft AO into base color so corners, overhangs, windows, arches, stairs and recesses gain depth while the art still reads as clean solid color. Never crush crevices to black or leave dirty patches and dark outlines. Bake each asset alone, so it carries only self-occlusion; ground contact and cast shadows come from runtime lighting, never baked sun or neighbors. The recipe and UV rules are in [agent-contract.txt](../tools/blender/demo/agent-contract.txt); scale AO reach to the asset. Keep flat-color and raw AO sources beside the combined atlas so strength can be retuned.

### Shading normals

Round things shade round: cylinders, cones, domes, spheres, arches, barrels, round towers and characters' bell-shaped bodies and heads, with low segment counts and smooth normals. Planar or sharp things stay hard: walls, roof planes, ridges, bevels, steps, crystals, rocks and deliberately faceted masses such as hair. Soft canvas shades smooth across gentle folds but keeps crisp rims and seams. Trees, cliff rocks and Aether outcrops stay faceted; animals shade smooth except folds sharper than about 60°. The tool is described in [DEMO_ASSET_PRODUCTION.md](DEMO_ASSET_PRODUCTION.md#shading-normals).

## Readability and scale

Assets must read from the zoomed-out management camera through silhouette, roofline, footprint, color areas and massing; detail lost at that distance has low priority.

Ordinary houses are about 1×1 to 2×2 cells; a late landmark around 8×8 should dwarf them through broad foundations, central masses, tiers, stairs and towers. Doors, stairs, windows and props stay legible as human-scale references. Import conventions are in [DEMO_ASSET_PRODUCTION.md](DEMO_ASSET_PRODUCTION.md#source-and-imports).

## Environment

Terrain, cliffs, rocks, vegetation, water, roads, props, citizens and wonders share one language; nothing uses a separate realistic look.

### Terrain

The target is *Diplomacy is Not an Option*: green meadow broken by broad light, dark and dry patches, dense wild-grass stands with open clearings, blocky pale sediment-stone massifs with shelves and bevelled rims, dense conifer woods with scattered broadleaves, blue water lightening toward shore, and a warm sun with soft shadows and cool fill. Source colors live in the terrain config, cliff material and Blender generators.

![Current Unity terrain: pale cliffs, meadow clearings, dense woodland, cyan Aether deposits, and foamed waterways.](art-references/terrain-style.png)

- **Dirt patches:** pale dry soil, dark earth and warm clay in large shapes plus a smaller scale, with broad quiet areas between. They must contrast clearly with grass, since green-on-green reads as a shading artifact. A restrained seamless soil texture inside them is the one deliberate exception to flat color; roads share it. Grass never grows inside dirt, including wind-blown tips. Purely visual, not a soil system.
- **Close detail:** a very washed-out, broad color wash on clearings so close views do not look like a solid fill, fading with distance so management views stay quiet.
- **Cliffs:** flat terraces, straight vertical walls and a broad visible chamfer on every rim; no noisy relief. Mesas vary their floor heights; outlines curve to hide grid steps. Upper terraces need a solid 2×2 footprint, and rock stays back from water. Color comes from uneven world-space sediment bands and a base-to-rim gradient, with sparse darker weathering marks near ledges, changing color only. Blender slabs break up selected walls below the rim; cliff-top rocks have distinct silhouettes (low plate, angular wedge, uneven cluster) scaled to their floor height, with plenty of bare stone between.
- **Trees:** shared flat-color atlas with baked self-AO, no leaf or bark noise, kept short so early housing stays prominent. Conifers have uneven layered skirts and broad shoulders; broadleaves follow Greenbough.
- **Grass:** opaque blade strips without AO in large irregular stands with thinning edges; no scattered lone tufts. Blades take the ground color at the root and lighten toward the tip, with upward normals matching the ground. Distant clumps simplify and fade rather than pop.
- **Wind:** one prevailing wind with travelling gusts and quiet spells. Grass reacts quickly, crowns follow with a slight delay, roots stay anchored; readable but quiet at city view.

### Water

- Ocean beaches use muted beige sand descending gradually into a shallow shelf. River sand is much narrower and slightly warmer so waterways do not become bright outlines. Enclosed lakes keep grassy banks. The sand edge is crisp, varies in width and never reveals triangles.
- Water is calm, flat and blue-teal, with slowly drifting color patches, a soft cellular network up close, restrained refraction, faint caustics and gentle reflections of opaque scenery; no directional wave bands, bright foam rivers or glossy highlights.
- Foam alone shows waves: opaque strokes with narrow antialiased edges and tapered ends, where coverage changes width, not opacity. Open coasts get breakers that wash up the sand as a thin sheet and recede, leaving darker wet sand; no spray. Small lakes get thinner, slower, muted foam. It is stylized, not fluid simulation.

## Magic

Magic stays restrained so late-game infrastructure feels special: glowing crystals, runes, floating geometric elements, magical light and controlled emissive accents, never particles on everything. Integrate it into architecture, like Asterhold's housed crystal, and keep ordinary workshops and vegetation quieter.

## Lighting and presentation

Judge assets under ordinary soft daylight: a slightly warm key light with soft, readable shadows, generous cool-neutral fill, mild contact shadows and restrained highlights. Avoid rim lights, very dark shadows, heavy bloom or cinematic grading that hide modelling problems. Judge at gameplay size as well as close up, and compare a Unity asset with its Blender reference under equivalent light before treating a lighting change as settled.

In game, cast shadows are softened below full strength. Avoid large shadow normal offsets, which leak light between flat cliff faces. Post-processing is gentle daylight: neutral tonemapping, slight contrast and saturation lift, slightly warm balance, restrained bloom and a light vignette. Never use depth of field, motion blur or film grain; avoid lens distortion and chromatic aberration; keep screen-space AO light so it does not double-darken baked AO.

### Map-edge mist

Broad, slowly moving slate-blue banks with silver-blue crowns and deep blue shadows hide the square map edge behind one continuous, irregular, rounded edge, rising into taller banks farther out, with only a trace of Aether-cyan glow. Never a white surround or flat backdrop. The playable contour never moves, and terrain is never tinted, darkened or desaturated near the border.

![Wide view of the rounded, irregular mist perimeter around the terrain and waterways.](art-references/avalon-mist.png)

## Camera

A high three-quarter camera that keeps the cell grid readable and shows both district planning and citywide spectacle. It never tilts on its own and never clears fog; over fog it only rises. Review assets in orthographic or near-isometric framing with enough frontage to read entrances, and keep studio ground, lights and scale proxies out of exported geometry.

## Visual studies

Together they set the range: the monument for grandeur, the workshop for everyday activity, the tree for nature. Footprints, polygon counts and names in them are references, not content specs.

**Asterhold, monumental citadel:** a heavy raised base, central keep, four towers, monumental entrance and stairs, varied roofs, and one cyan crystal. A magical landmark must still feel like a substantial building.

![Asterhold citadel: large pale-stone civic keep with blue roofs, monumental stairs, and a cyan beacon.](art-references/asterhold-citadel.png)

**Ironhearth, blacksmith:** a compact stone-and-timber workshop with a broad slate gable, an open forge and a modest chimney. Tools supply detail while roof and walls stay simple.

![Ironhearth blacksmith: stone-and-timber workshop with open forge, grindstone, anvil, tool racks, and blue slate roof.](art-references/ironhearth-blacksmith.jpg)

**Greenbough, broadleaf tree:** a bent, tapering trunk with visible forks and root flares under a few large, unequal faceted foliage masses in three related greens. Branches meet the trunk cleanly and end inside foliage. Other species differ by crown, trunk and branching, not surface treatment.

![Greenbough tree: muted green faceted canopy, warm brown forked trunk, and broad roots under soft daylight.](art-references/greenbough-tree.jpg)

### Characters

The wizard and villager sheets set the look for walkers and named characters: a compact build with an oversized head, dot eyes, round nose, legless bell-shaped body and spherical hands; hair and cloth as broad faceted masses; the building palette, with gold and cyan reserved for the wizard. Props are separate pieces.

![Wizard character sheet: bearded wizard in blue-and-cream robes and a pointed hat, with a separate gold-and-crystal staff.](art-references/merlin.png)

![Female villager character sheet: villager in a blue dress, cream apron, and headscarf, with a separate bread basket.](art-references/villager-female.png)

![Male villager character sheet: villager in a belted blue tunic, with a separate cloth sack.](art-references/villager-male.png)

- Figures move procedurally: a bob and sway, a steady turn toward new headings rather than a snap, and arms swinging in step. The swing follows what each hand holds: a free arm swings fully, a hanging prop swings less and against the free arm, a braced prop (cart, staff, ledger) holds its arm still, a two-handed prop rocks with both arms. Hands never leave their props.
- Figures never pop or fade: they grow in with a slight overshoot, and before removal they stand still briefly, then swell and shrink away, on unscaled time. Materials stay opaque.

### Wildlife and beach props

Animals continue the characters' legless silhouette (rounded undersides, no feet or hooves) with broad faceted forms, matte colors and simple oval eyes. The concept sheets and their prompts ([wildlife](art-references/wildlife-concept-prompts.json), [bunny](art-references/meadow-bunny-prompts.json)) are in `art-references/`; the land bird sheet is still titled "Shore Gull". Beach sheets are composition studies, not placement or scale specs.

![Shore crab](art-references/shore-crab.png) ![Meadow sheep](art-references/meadow-sheep.png) ![Silverfin fish](art-references/silverfin-fish-v2.png) ![Land bird](art-references/land-bird.png) ![Garden snail](art-references/garden-snail.png) ![Meadow bunny](art-references/meadow-bunny-ivory.png) ![Beach decorations](art-references/beach-decorations.png)

- **Motion** is soft, natural and cozy: quiet life that rewards a closer look. Ease into walks and rests, turn gently, keep bobs small and space out idle gestures; no constant fidgeting. Fish stay upright and never jump; snail shells stay rigid; bunnies travel only while airborne.
- **Scale:** one common building-relative multiplier keeps species in proportion, with the sheep as reference. Snails are deliberately giant, fish are doubled for readability and beach props exaggerated.
- **Habitat:** land animals enliven open, unused ground away from trees, cliffs and resources. Sheep seek grass; snails are rare, solitary finds on barer ground; bunnies keep to woodland margins and lone trees, never forest interiors. Land birds are uncommon, in loose flocks of two to four, never tight formations or circling fish banks. Crabs stay on beaches, fish in water.
- Fish form loose schools on slow, offset figure-eights, never compact rings. Blue regions turn warm gold in game so fish stay visible underwater.
- Beach props sit in loose wrack patches bedded into sand; a subtle foam rim appears only while the wash touches them. Snail trails are a soft, uniform dark olive that fades, with no highlights or rings.

### Wildlife pipeline

The editable library is `tools/blender/wildlife/wildlife_library.blend`, rebuilt with Blender 5.2 from the repository root:

```text
blender --background --factory-startup --python tools/blender/generate_wildlife.py
```

`export_wildlife.py` writes game GLBs and `export_wildlife_unity.py` converts them to FBX under `Art/Wildlife`; then run **Rebuild Wildlife Assets** in Unity, which keeps GUIDs and tuning. The land bird (`rebuild_gull.py`, from `wildlife/sources/land_bird.blend`) and bunny (`MeadowBunny.blend`) have their own sources and per-species rebuild menu items.

## Asset review checklist

1. **Silhouette:** recognizable at city distance, with emphasis that suits its role.
2. **Composition:** entrance, work area, main tower or tree forks readable; secondary forms support the main shape.
3. **Construction:** supports connected, roof joins deliberate, windows clear, roots grounded; no gaps or stray intersections from any angle.
4. **Detail:** props communicate function; no micro-decoration or clutter.
5. **Surfaces:** coherent colors, economical geometry, soft AO, no UV overlap or bleed, no noisy textures or normal maps.
6. **Presentation:** holds up in ordinary daylight and zoomed out; presentation objects kept out of the asset.
7. **Handoff:** editable scene, final atlas, flat-color and AO sources, a render, and a verified export.

A wonder passes when it makes a city screenshot substantially more impressive; an ordinary asset passes when it adds a readable, convincing part of the same world.
