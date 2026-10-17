# Generator units

A Generator is a Build with the `generator` flag: a unit that takes one or more
asset generation jobs (images, textures, sounds, music, 3D, motions), makes
them with the bundled asset helpers, places them in the project and finishes
like any worker. It is the Modeller flow without a live view: the terminal is
the main area of its page, card and rail row.

## Starting one

- Chat: `deploy` or `quest_add` with `kind: "ship", generator: true` (refused on
  Recon), `quest_update generator` on a queued quest. List the jobs in the
  intent or spec.
- Deploy dialog: the Generator option (magenta). Quest log: the Generator kind.
- `claims`: the project paths it will write, from `asset_locate`. A spawn whose
  path another Generator or Modeller holds is deferred; the quest stays queued
  until that unit lands or is despawned (`claimConflict` in
  `src/shared/modeller.ts`, shared with Modellers). While it works, its
  `note [key=claim]: <path>` lines add claims and a clash with an older holder
  raises one choice (`stepModeller` in `src/main/supervisor.ts`).
- Mutually exclusive with `modeller`: both in one request is refused; a flag in
  the request replaces the quest's other flag; a quest filed with both keeps
  the Modeller flag. A Generator that happens to start a Blender model never
  becomes a Modeller.

## Brief

A Generator has the same skills as every other unit: the shared `# Tools` section and launch environment
(Codex images, FAL, Uthana, the Sound Studio, Blender, Unity, assets, the Art Bible), see
[unit-worktrees.md](unit-worktrees.md#every-unit-gets-every-capability). A Recon, Build or Modeller can make
the same assets under the same spend rules; we prefer generation work to be done in units, and a Generator is
simply the unit whose mission is the job list.

`generatorBrief` in `src/main/brief.ts` adds only its own rules, in a short `# Generator` section:
the job list, spending only under the spend grant the player approved (no
default budget: an approved budget at deploy, or the player's approval of the
unit's `needs-decision [key=spend]` question; see docs/agent-generation.md), the helper per job
(Codex images on the ChatGPT plan for ordinary images; FAL for textures, 3D,
audio and music; the Uthana helper uthana.mjs for motions), the
Sound Studio steps for trimming, looping and normalizing, the Art Bible applied
by the helpers (`--type <asset type>`), paths from asset_locate and claims,
takes kept outside the worktree and never committed unless chosen, Unity
`.meta` from `genio-unity import` (or a note that Unity could not run),
provenance and spend lines committed with the assets, and opening and judging
every result instead of trusting metadata.

## Landing

It commits, reports `done` and shows READY TO MERGE; Auto-loot or the player
merges it. There is no Accept step. In Hardcore the Gauntlet skips the checks
and the AI review, as for a Modeller: sync, an `assets` information step
listing the delivered files (`generatorReport`), push and PR.

The chat's own `generate_image` (Codex images in the chat,
`src/main/chat-imagegen.ts`) is separate and unchanged: Genio still makes an
image directly when asked.

Achievements: Production Line (`generator-first`) when a Generator's build merges; a Modeller's merge earns Model Citizen (`modeller-first`). Take Two (`modeller-rewind`, a Revert or Branch from the unit page) is retired with those buttons.
