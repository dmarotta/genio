# Unit worktrees and their node_modules

Every unit works in its own git worktree. In a project with a `package.json`, every unit worktree also gets
its **own real `node_modules`**. A unit can never install into the main checkout's `node_modules`, and Genio
does not crash when that folder is broken.

## Why

Units used to make their own `node_modules` as a junction to the main checkout's, to avoid installing per
worktree. `npm ci` deletes `node_modules` before it installs. Run through such a junction, it wiped the main
checkout's folder and reinstalled it from the unit branch's lockfile. `.bin`, `electron.exe` and the Claude
Agent SDK went missing, and Genio would not start.

## The four parts

### 1. Private setup at launch

`crew.ts` starts `startWorktreeDeps` (`worktree-deps.ts`) on every launch and respawn. It runs once per
worktree, in the background, and does nothing if the worktree has no `package.json` or already has a real
`node_modules`. The work is done by `setupNodeModules` (`resources/unit-skills/genio/lib/node-deps.mjs`):

- A `node_modules` link already in the worktree is removed first (the link only, see Repair).
- If the worktree's lockfile hashes the same as the main checkout's (sha256 of `package-lock.json`,
  `npm-shrinkwrap.json`, `pnpm-lock.yaml` or `yarn.lock`), and the main install passes the health check, the
  main `node_modules` is **copied**. On a Dev Drive or other block-cloning volume this uses `seedTree` from
  `clone.mjs` and costs almost nothing. Otherwise it is a 16-thread `robocopy /XJ` (`robocopyTree` in
  `unity-seed.mjs`), about a minute for Genio's 1 GB. Elsewhere it is `fs.cp`. Links are never copied.
- If the hashes differ, or the copy fails, Genio runs `npm ci --prefer-offline` **inside the worktree only**.
  A project with only a pnpm or yarn lockfile is copied when the hashes match. Otherwise it is left for the
  unit to install.
- The result is never a junction, symlink or hardlink. The main checkout is only read.
- While the player's Play is starting, the copy or `npm ci` waits until it is ready, stopped or failed, at
  most 10 minutes ([quiet start](player-instance.md#quiet-start)). `deps.json` stays `installing`, with
  `waiting: 'a Play is starting'`, and the final report records `deferredMs`.

Progress goes to `data/<task>/deps.json` (`installing`, `ready`, `failed` or `skipped`, plus the method) and to
`note [key=deps]` status lines, which the unit page's Timeline hides unless setup failed. The brief (`nodeDepsLines` in `brief.ts`)
covers three things. The unit's `node_modules` is private, so it may run `npm install` or `npm ci` in its
worktree. It must never link, junction or move `node_modules`, or touch the main checkout's. And
`node "<plugin>/lib/npm-guard.mjs" setup` repairs a missing or linked `node_modules`. That script is also in
`GENIO_DEPS_SETUP`.

What Genio did is logged to `<Genio home>/state/worktree-deps.jsonl`.

### 2. Guard

- **PATH shims.** `npm`, `npx`, `pnpm` and `yarn` shims live in the unit's `unit-bin` (`installNpmShims`), next
  to the Unity shims. Each one runs `npm-guard.mjs <tool> <args>` first. The real tool, resolved from the
  inherited PATH when the shim is written, runs only if the guard exits 0. The guard refuses `install`, `ci`,
  `uninstall`, `update`, `prune`, `dedupe`, `rebuild`, `exec`, `link` and their aliases, every `npx`, and
  pnpm/yarn equivalents, but only in these cases:
  - the target folder (cwd, or `--prefix`/`-C`/`--dir`/`--cwd`) or any of its parents has a `node_modules`
    that is a junction or symlink;
  - a `node_modules` inside the worktree resolves outside it;
  - the target is the main checkout;
  - Genio's own setup is still running.

  A refusal exits 23 and names the fix. Read-only commands (`npm run`, `npm test`, `npm ls`) always run.
- **PreToolUse hook.** Claude units get a `Bash|PowerShell` hook (`depsPreToolHook`, `npm-guard.mjs --hook`)
  next to the Unity one. It denies the following (exit 2):
  - creating a link at `node_modules`: `mklink /J`, `New-Item -ItemType Junction|SymbolicLink|HardLink`,
    `ln -s`, `symlinkSync`;
  - moving `node_modules`;
  - a recursive delete (`rmdir /s`, `Remove-Item -Recurse`, `rm -r`, `rimraf`, `rmSync`) of a path that is, or
    lies under, a `node_modules` link;
  - installs through a linked tree.

  Nested `cmd /c`, `powershell -Command` and `node -e` text is checked too. `echo`, `git` and searches are
  not. `cmd /c rmdir "<link>"` without `/s` is allowed, because it removes only the link. If the hook itself
  fails, it lets the command through, unlike the Unity hook.
- **Process watch.** Every 5 seconds the supervisor checks each live unit's worktree with `createDepsWatch`.
  A linked `node_modules` gets one `note [key=deps-guard]` and an inbox message. While one is linked, any
  package-manager install among the unit's child processes is noted once per process. Nothing is killed.

The unit's terminal carries `GENIO_DEPS_WORKTREE`, `GENIO_DEPS_MAIN`, `GENIO_DEPS_STATE` and
`GENIO_DEPS_SETUP`. As with the Unity guard, this detects and denies; it is not a sandbox.

### 3. Repair

`crew.sweepWorktrees()` runs at startup (`startApp`) and after every despawn, one sweep at a time. It looks at
each base's `worktrees/<project>/<unit>` folders, including any on a Dev Drive, both registered folders and
leftovers git no longer knows.

- **Links.** A `node_modules` junction or symlink is removed with `removeLinkSafely`. That is `fs.rmdirSync` on
  the link itself, the same as `cmd /c rmdir "<path>"`. It is never a recursive delete through the link, and
  never `Remove-Item -Recurse`, which can follow a junction in PowerShell 5.1. Before removing, lstat must
  report a link. Afterwards the link must be gone and its target must still exist. A real folder is never
  touched. A live unit's link is left alone: the unit is told once through its inbox to remove it and run setup.
- **Despawn.** The unit is stopped first (its agent and any terminal open in its copy). Its own `node_modules`
  link is removed before `git worktree remove`, so removing the worktree cannot reach through it. Work that has
  not landed is refused, with the exact files and commits, unless the player discards it. Two paths can: the
  Despawn confirm's Discard click (the `cleanupTask` IPC, the only path that records `by: click`), and the chat's
  despawn tool with force and the player's own verified words (`verifyDiscardWords` in `player-words.ts`: any
  plain removal words, sent after the unit existed, naming it or replying to Genio's message about it; never a
  question). Force only goes past what would be lost: a landed unit despawns as without it. The main copy and
  any registered project's folder are never removed, forced or not.
- **Leftovers.** A folder git no longer lists is deleted only when its unit is `cleaned` with a landed (or
  Recon) despawn verdict, which is the existing guarded despawn rule. Links inside are removed first.
  Every other leftover is listed with its reason and left untouched. Examples: no unit record, unit still
  active, forced despawn, unregistered project, or a delete that failed. Nothing is forced.

### 4. Main install health check

On an unpackaged start, `boot()` in `index.ts` runs `genioInstallReport` before anything else. It checks that
these exist: `node_modules/.bin`, Electron's binary (`electron/path.txt` → `dist/`), every runtime
dependency, and `@anthropic-ai/claude-agent-sdk`, `three`, `electron` and `electron-vite`. These are
existence checks only. If any is missing, Genio shows a plain recovery card (`recoveryCardHtml`,
`install-health.ts`) instead of the app. The card reads "Dependencies are broken: run npm install in
<path>", lists what is missing, and has a Copy button for `npm install --prefix "<path>"`. It also logs the
missing entries and every unit worktree whose `node_modules` links to the checkout, both to the console and
to `<Genio home>/state/install-health.log`. Genio never runs npm install in its own checkout.

Electron cannot show the card when its own binary or `.bin` is gone. For that case, `npm run dev` and
`npm start` run the same check first (`predev` / `prestart`: `scripts/check-install.mjs`), which prints the
same message and exits 1. A packaged build skips the check.

## Every unit gets every capability

The worktree is the same for every unit, and so is what it can use. Every unit, whatever its kind (Recon,
Build, Modeller, Generator) or runtime (Claude Code, Codex, Gemini, OpenCode and the rest), gets the whole
skill set: assets, imagegen-codex (Codex images on the ChatGPT plan), fal, uthana, sound (the Sound Studio),
blender and unity, plus the Art Bible when the project has one. Only the mission rules differ: a Recon does
not commit, a Modeller and a Generator keep their claims and landing rules.

- **One list.** `UNIT_CAPABILITIES` in `src/main/unitskills.ts` names each skill, its path variable and its
  own prerequisite. Blender needs a local Blender, Unity a Unity project, FAL and Uthana their key and a spend
  grant, Codex images only the player's ChatGPT plan.
- **Brief.** `unitBriefSections` (`brief.ts`) gives every kind the same `# Tools` section (`unitToolsBrief`).
  It opens with the capability list and the line "Work is best done in units, and any paid call needs an
  approval". A Modeller or Generator section adds only that kind's rules. A Recon upgraded to a Build gets
  the same Tools again, with the grant the player approved so far.
- **Environment.** `unitLaunchExtras` sets the same variables for every runtime: one `GENIO_<SKILL>_SKILL`
  per skill (`GENIO_ASSETS_SKILL`, `GENIO_IMAGEGEN_CODEX_SKILL`, `GENIO_FAL_SKILL`, `GENIO_UTHANA_SKILL`,
  `GENIO_SOUND_SKILL`, `GENIO_BLENDER_SKILL`, `GENIO_UNITY_SKILL`), `GENIO_UNITY`, the helpers' data folders
  (`GENIO_BLENDER_SCRATCH`, `GENIO_MODELLER_DATA`, `GENIO_SOUND_DATA`, `GENIO_CODEX_IMAGE_SCRATCH`,
  `GENIO_UTHANA_DATA`), `GENIO_HELP_DOCS`, the spend grant (`GENIO_SPEND_GRANT`, `GENIO_SPEND_KEY`) and
  `FAL_KEY` / `UTHANA_API_KEY` when the player set them. A key is never permission to spend: the paid
  helpers refuse without a grant ([agent-generation.md](agent-generation.md)). Claude Code also gets
  `--plugin-dir`, which is only its native way to load the same skills. Unity projects add the genio-unity
  config and shims ([unity-enforcement.md](unity-enforcement.md)).
- **Guard.** `tests/unit-capabilities.test.ts` renders every kind's brief for every built-in runtime and the
  launch environment per runtime. It fails when one kind or runtime lacks a skill (`capabilityGaps`).
  `tests/crew-lifecycle.test.ts` deploys each kind for real and compares their environments.

## Tests

`tests/node-deps.test.ts` and `tests/worktree-deps.test.ts` use real junctions in temp folders
(`fs.symlinkSync(target, link, 'junction')`) and clean up with the link-first `removeTreeSafely`. They
cover:

- the junction-removal regression: the target's files are intact;
- the shim end to end: it refuses `npm ci` through a junction and runs the real tool in a real folder;
- the hook rules;
- seeding by copy when the lockfile hashes match, and `npm ci` when they do not;
- the sweep, the process watch and the health card.
