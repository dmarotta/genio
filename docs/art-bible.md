# Art Bible

A project's art direction lives in `.genio/art-bible.md`: committed markdown with a small front matter. A project has a bible only when the player creates that file. Nothing looks for other docs or creates one automatically. A missing or empty file means no bible, and the compiler returns `null`, so no style is applied.

Code: `resources/unit-skills/genio/lib/art-bible.mjs` (standard library only, shared by Genio's main process and the unit helpers) and the `genio-art.mjs` CLI next to it. Generators are not wired to it yet.

## Format

```markdown
---
schema: genio.art-bible.v1
kind: game-3d-stylized            # template id (optional)
source: docs/ART_DIRECTION.md     # optional: an existing doc this file extends
avoid: [photo textures, grunge, rim lights]
defaults: { image: png 1:1 1024, model: glb <=10k tris }
---
# Art Bible: Founders of Avalon

## Style
One or two paragraphs; the first 400 characters are the summary.

## Palette
| Role | Color | Use |
|---|---|---|
| Warm limestone | `#CBBF9F` | walls, arches |

### Accents
| Cyan Aether | `#53D9D1` | crystals only |

## References
![Ironhearth blacksmith](../docs/art-references/ironhearth-blacksmith.jpg "style buildings 3")

## Do
- Fix weak forms with recesses and roof breaks
## Don't
- Modelled brickwork, tiny shingles

## Buildings
Chunky readable masses, large roofs, recesses.
## Audio
Warm acoustic medieval; soft transients.

## Review checklist
1. Silhouette: recognizable at city distance
```

- **Front matter** is a flat YAML subset: `key: value`, inline `[lists]` and `{ maps }`, indented `- item` lists, quotes and `# comments`.
- **Headings** are matched loosely: `Summary` or `Overview` count as Style, any heading with "palette" is the Palette, any heading with "checklist" is the Review checklist.
- **Per-type sections**: Concepts, Sprites & icons, UI, Textures, 3D models, Buildings, Characters, Wildlife, Audio, Music, Voice and Animation, plus any other level-2 heading as a custom type. Each gives one line of up to 300 characters.
- **References** are markdown images, resolved relative to the file they appear in. The title carries `role type weight`: role is `style`, `subject` or `layout`, and weight is 1 to 3. An untitled image is a style reference at weight 1 for the type of the section it sits in, or for every type. External URLs and paths outside the project are never sent.
- **Limits**: a warning at 16 KB, no compiling above 64 KB, 24 references, 20 avoid terms.
- **Version**: the file's git blob id (`version.blob`, plus `version.source_blob` with a source).

## `source:`: extending an existing doc

With `source: <path>` the bible is a thin file that extends an existing doc. The doc is read where it is and never written. `loadArtBible` merges the two into one resolved bible:

- **The source wins** on style, palette, references and checklist.
- **The bible adds** accents, avoid terms, reference weights (an image with the same path and a title), extra references, do/don't lines, and per-type notes (the bible's line wins over the source's section).
- **`origins`** names the file behind every part. Each palette entry and reference also carries `origin`, and each reference carries `weight_origin`.

founders-of-avalon's `docs/ART_DIRECTION.md` parses without edits: 10 palette colours, 15 references and 7 checklist items (`tests/art-bible.test.ts`).

## Compiling

`compile({ world | bible, provider, endpoint, schema, type, subject })` returns `prompt` (subject first), `prefix` (the compiled style that follows the subject), `negative`, `refs`, `palette`, `params` to merge into the provider input, `applied`, `notes` and `version`.

| Target | What it gets |
|---|---|
| Codex | Subject, then the style with hex palette (at most 1,200 characters), the type line, "Avoid: …", and the top 2 type references with "STYLE references only". Total at most 4,000 characters. |
| FAL text-to-image | Subject first, then at most 350 characters of style: summary, colour names (no hex). `negative_prompt` only where the schema has it. |
| FAL edit / multi-reference | As text-to-image, plus `image_urls` with up to 4 type references (`@file:` paths). |
| Recraft | A style line of at most 200 characters, `colors` from the palette, and `style_id` when given. `create-style` gets the type references. |
| Image2Pixel | `fixed_palette` and `max_colors` from the palette. |
| 3D | The 3D models line and `defaults.model`. |
| Audio, music, voice, Uthana | Only their own section, never the visual style. |

When text runs over a budget it is cut in this order: per-type line, do/don't lines, palette detail (uses, then hex), summary.

## Helpers and CLI

- `parseArtBible`, `mergeArtBible` and `loadArtBible` parse and resolve; `summarize` gives counts.
- `selectRefs(bible, type, n)` ranks references.
- `readArtBibleText(root)` and `writeArtBible(root, text)` are plain file helpers. A write that would not compile, for example a `source:` that does not resolve, is refused. Genio never commits.

```text
node resources/unit-skills/genio/lib/genio-art.mjs show|compile|refs|check --world <root> [--type building] [--provider codex|fal|uthana] [--endpoint <id>] [--subject <text>]
```

The CLI only reads. It prints one JSON document, and exits 2 on usage errors and 3 when the bible has errors.
