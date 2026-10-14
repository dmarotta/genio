# Unity validation in the Gauntlet

The default Unity test step is `genio-unity test --mode EditMode`. Existing generated `Unity -batchmode` and Hub editor commands are recognized and routed through the same wrapper. Unity projects with no saved test command also receive this gate; custom test commands retain their shell behavior.

The Gauntlet writes a separate `<task>.gauntlet-unity.json` config and stores wrapper runs under the task's `gauntlet/unity/` directory. The target is the worktree's stored engine root. The wrapper seeds its Library from the registered project, excluding editor credentials and locks, and acquires a seat in the main home's `data/unity-editors/` semaphore. Ally Gauntlets use that same directory. The wrapper releases the seat when its editor finishes. Each run preserves `result.json`, NUnit/JUnit reports and editor/CLI logs when available.

A test step passes only with wrapper exit 0 and a valid NUnit report for that run: at least one test executed and none failed. Skipped cases do not count as executed. Zero tests, all skipped cases, NUnit failures even with exit 0, and exit 8 become unit findings. Exit 6/7 and other nonzero infrastructure/refusal codes, missing or invalid reports, and launch failures raise a recovery choice without spending a unit fix round. The choice's context and the validation step contain the run diagnostics.

Missing editors now finish the validation run as failed and raise recovery. Completion-triggered preflight refusals or exceptions move the task out of `validating`. The wrapper requires no new options for this integration.

`tests/gauntlet-unity.test.ts` exercises the pipeline with the fake Unity CLI, including Library seeding, shared semaphore occupancy and contention, strict NUnit gates, infrastructure routing, legacy defaults and custom commands. No real editor is started.
