# Plans

A plan is work for two or more units in a set order. It is a list of named
steps, and each step is an ordinary quest. Genio starts each step by itself
once the steps it comes after have merged. The main chat does the splitting,
so plans work with every unit tool, and each step can have its own loadout.

Code: `src/main/plans.ts` (store and sequencing), `src/shared/work-plan.ts`
(step states and the plan view), `src/shared/plan-estimate.ts` (time and cost),
`src/main/plan-hints.ts` (rebase hints), and the tools in `src/main/wksp-tools.ts`.
The store is `<home>/data/plans.json`. Internally it is called `WorkPlan`,
because `PlanId` already means a provider quota plan.

## When the main chat plans

The rules are in the contract (`src/main/prompts.ts`). The always-on contract
has one line, the `intake` procedure has the full rules, and the plan tool
descriptions repeat what matters at the point of use.

- Plan when work needs 2 or more units: a Recon proposed builds, the work spans
  several subsystems, or one unit would likely run past about 60 min.
- Don't plan one-sentence diffs, tightly coupled changes to the same files (one
  unit), or speculative parallel designs.
- Serial by default. Steps run in parallel only when they share no API and few
  files, at most 2 at once (`max_parallel`, 3 at most).
- Order lives only in `after`. A step waits for the merge of its own
  prerequisites, never for unrelated steps. There is no early start.
- Each step has a complete spec, a one-line acceptance check and the files it
  shares with other steps, and optionally a `summary`: a few plain lines for the
  player. It goes to the step's quest and its unit's Brief tab (without one, the
  tab derives it from the spec).
- A step can carry `attachments` (the player's images, files, folders or text;
  [unit-worktrees.md](unit-worktrees.md#attachments-references)). They are
  copied when the step's quest is filed, so they are still there when the step
  starts; `edit_step` adds to them.
- Post the announcement once (steps, order, time, cost). If the player already
  asked for the work, start it and carry on without asking; otherwise file it
  with `start=false` and ask.
- Merge approval does not change. Genio starts the next step only after a merge,
  so a plan simply waits at an unapproved merge.

## Tools

- `plan_create`: validates keys, cycles and prerequisites, files one quest per
  step (its `dependsOn` mirrors `after`), stores the estimate and releases the
  steps that are ready. It returns the plan id, step quest ids, the estimate
  and the announcement.
- `plan_update`: the only way to change steps (`edit_step`, `add_step`,
  `remove_step`, `reorder`) or the plan (`pause`, `resume`, `cancel`,
  `settings`). Steps that have started keep their brief. Every step change
  recomputes the estimate.
- `plan_status`: the derived view: step states, the steps next to start,
  blockers, landed commits, the estimate, and `left` (what remains for the steps
  that have not merged).

## Sequencing

- When a step lands, Genio records the commit, done line and changed files, then
  releases the steps that became ready through `crew.spawn`. Project capacity,
  the independent global Units at once setting, quota waits and the plan's
  `max_parallel` all apply. A step held back for
  capacity is retried when a unit stops working.
- Each released brief gets a "Plan context" block with the plan, the step's
  acceptance line, and what landed before it.
- A failed or discarded step pauses the plan and opens one choice: resume, edit
  the step, or cancel.

## Time and cost estimate

`estimatePlan` works from the squad's own history:

- **Step run time**: minutes from launch to first finish of finished, not
  discarded units of the same kind. It prefers the same category, then the same
  project, and needs at least 3 runs. The range is [median, 75th percentile].
  Without history it uses 20-45 min for a Build and 15-35 min for a Recon.
- **Elapsed time**: the longest chain of `after`, or total unit time divided by
  `max_parallel` when that is longer. Time spent waiting for merge approval is
  not counted.
- **Main chat cost**: the chat's spend divided by the units it has run (at least
  5), ±15% per step. Without that it uses $0.50-0.70 per unit.

With no history, a serial plan of three Builds is announced as: `About 1h 0m-2h 30m,
3 units (~1.5 unit-hours), main chat ~$1.50-2.10`.

## Rebase hints

When a step lands, Genio compares the files it changed with the `files` hints
of the plan's other steps that are working or waiting for their merge. For each
overlap it pings that unit: which step landed, the commit, the overlapping files,
and "rebase onto the base branch before you finish". If a ready unit's terminal
has closed, Genio relaunches it so it can rebase. The main chat gets one routine
notification listing the pings.

A hint can be a path, a folder, a bare file name (matched in any folder) or a
glob (`*`, `**`, `?`). Always-hot files never trigger a hint, because most
concurrent pairs touch them: `types.ts`, `api.ts`, `ipc.ts`, `app.css`,
tsconfigs and lockfiles.

In the Quest log a plan's quests sit in one group under the plan's chip and its
progress ("plan · 1/3 merged"). The chip opens the steps with Pause plan and
Cancel plan; unit pages and tickets carry no plan chip. A step's card and
details have no Dispatch, Drop or priority control: those belong to the plan
(plans have no priority of their own yet).

Achievements: Battle Plan (`plan-first`, a plan filed), Hold Everything (`plan-control`, Pause or Cancel from the plan chip's popover in the Quest log) and According to Plan (`plan-done`, every step merged).
