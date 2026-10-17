# Structured unit choices

Unit status logs still accept legacy prose. For answer buttons and reviewed batches, append JSON after ` || ` on the same `needs-decision` or `blocked` line:

```text
needs-decision [key=scene]: May I close my isolated test scene to run checks? || {"options":["Close the test scene and run checks","Keep it open"],"recommendation":"Close the test scene and run checks","details":"Only the isolated test copy is affected. PID, project path, command and rationale go here.","batch":"scene-checks"}
```

Use a JSON encoder and write the complete line without executing diagnostic text through shell interpolation. `options`, `recommendation`, `details` and `batch` are optional. Malformed metadata remains visible as legacy prose. `details` is shown under the question, always in view; each option is its own row, with the recommended one marked Recommended. A repeated task/key updates the existing choice and retains clarification history. Generated unit briefs include this contract.

Recommendations contain the exact proposed answer. A batch uses only explicit recommendations, never recommendations inferred from legacy question prose. Related choices group by base and project plus explicit batch slug; without a slug they group by originating task (or quest). Unrelated, unassigned choices remain individual.

Review recommendations captures the named questions, Details, exact answers, IDs and persisted revisions. Apply recommendations (N) submits that captured set through the central answer service. Changed, deferred, answered or failed rows are reported individually; failed rows remain pending. Newly arriving choices cannot enter an existing review. Concurrent sends are rejected while a choice is being delivered. Unit inbox delivery must succeed before resolution; a failed terminal nudge after writing a durable inbox message still counts as delivery.

The panel's bottom bar has three actions. Lock in answers with the selected row (or, for an open question with no options, the typed words). Later sets the choice aside with no date (`held: "later"`): it leaves the popup and the pending count, is listed under Deferred with Resume, and a linked quest is held (quest_hold semantics, no date) until the answer releases it. Ask Genio sends the player's own chat message (the question, details, numbered options with the recommendation, and the asking unit's title, never ids) through the normal send path with the screen context, and sets the choice aside (`held: "genio"`). Either way the choice stays open: the unit still shows as waiting for the player, and choice_list still lists it. Genio explains the options, recommends one and asks which to lock in; it resolves the choice with choice_resolve only on the player's stated decision, an option or their own words passed verbatim, which pings the unit with exactly that text. The player can still answer it on the unit page, or Resume it to answer in the panel.

A clarification (a question about the choice, sent to the originating unit or owning Genio conversation) never resolves the decision, closes its status key, releases a held quest or grants approval. Its history persists on the original choice. Units must reply with a clearer question/options/Details under the same key and keep the obligation open until an actual answer arrives.
