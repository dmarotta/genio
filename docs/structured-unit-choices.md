# Structured unit choices

Unit status logs still accept legacy prose. For answer buttons and reviewed batches, append JSON after ` || ` on the same `needs-decision` or `blocked` line:

```text
needs-decision [key=scene]: May I close my isolated test scene to run checks? || {"options":["Close the test scene and run checks","Keep it open"],"recommendation":"Close the test scene and run checks","details":"Only the isolated test copy is affected. PID, project path, command and rationale go here.","batch":"scene-checks"}
```

Use a JSON encoder and write the complete line without executing diagnostic text through shell interpolation. `options`, `recommendation`, `details` and `batch` are optional. Malformed metadata remains visible as legacy prose. `details` becomes expandable Details; a repeated task/key updates the existing choice and retains clarification history. Generated unit briefs include this contract.

Recommendations contain the exact proposed answer. A batch uses only explicit recommendations, never recommendations inferred from legacy question prose. Related choices group by base and project plus explicit batch slug; without a slug they group by originating task (or quest). Unrelated, unassigned choices remain individual.

Review recommendations captures the named questions, Details, exact answers, IDs and persisted revisions. Apply recommendations (N) submits that captured set through the central answer service. Changed, deferred, answered or failed rows are reported individually; failed rows remain pending. Newly arriving choices cannot enter an existing review. Concurrent sends are rejected while a choice is being delivered. Unit inbox delivery must succeed before resolution; a failed terminal nudge after writing a durable inbox message still counts as delivery.

Ask for clarification sends the player's question to the originating unit or owning Genio conversation without resolving the decision, closing its status key, releasing a held quest or granting approval. Its history persists on the original choice. Units must reply with a clearer question/options/Details under the same key and keep the obligation open until an actual answer arrives.
