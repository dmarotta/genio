# Unity copy seeding

Play slots and `genio-unity` worktree runs use the same standard-library helper:
`resources/unit-skills/genio/lib/unity-seed.mjs`.

```js
import { seedLibrary } from '../resources/unit-skills/genio/lib/unity-seed.mjs'
const report = await seedLibrary(copyUnityRoot, sourceLibraryDirectory)
```

The helper seeds only when Library is absent. Windows uses
`robocopy /E /MT:16 /XJ /R:1 /W:1 /COPY:DAT /DCOPY:DAT`; codes 0–7 succeed,
codes 8 and above or a missing executable fail. Other platforms use `fs.cp`
with the same exclusions. PackageCache, Pipeline, Temp, Logs,
EditorInstance.json and `*-lock` files are withheld. UPM refills PackageCache.
Included source files and the completed copy must contain no symlinks,
junctions or hardlinks. Destination ancestors cannot be links either.

Seeding assembles a unique directory under the copy's ignored Temp directory,
then renames it to Library after validation. A copy failure removes that staging
directory, so a retry cannot reuse a partial Library. An abruptly killed process
can leave its ignored staging directory; it is never treated as Library.
Seeding reads the current source Library; it does not make databases consistent
while the source editor is writing them. Prefer an idle source editor and allow
Unity to refresh imports afterward.

Before copying, the helper checks free bytes on the destination filesystem.
It requires the planned payload plus the larger of 256 MiB or 10% as reserve.
Slot preparation checks before cloning or checkout too: committed Git blob
sizes, expanded LFS pointer sizes, the independent Git object copy, and the
included Library. Missing shared LFS objects are also budgeted and checked on
their own filesystem. These are prechecks, not reservations; other writers and
later Unity imports can still consume space. Slot disk estimates exclude
PackageCache and duplicated LFS storage.

Slots keep `git clone --no-hardlinks` for independent Git objects. Before LFS
checkout they set local `lfs.storage` to the registered project's effective
store (including a custom store). Working files are ordinary copies, not links.
Already cached objects are read directly; any download populates this shared
store instead of a per-slot store. Existing per-slot caches are retained when
switching their configuration; this change does not delete old caches. Shared
LFS storage follows the project's lifetime and pruning policy.

`seedLibrary` returns `{ seeded, elapsedMs }`, with `reason: 'exists' | 'missing'`
when skipped. A completed seed also reports `method`, `bytes`, `files`,
`estimatedBytes`, `requiredBytes`, and `availableBytes`. `genio-unity` records
this as `librarySeed` in result.json and keeps the existing `librarySeeded`
boolean. Play pool state.json and its state API expose `slot.preparation` with
the Library report, total elapsed time, preflight and Git phase times, actual
slot bytes/files, the preflight estimate/free space, and the shared LFS path.

Verification uses temporary repositories and trees only:

```text
npx vitest run tests/unity-seed.test.ts tests/play-pool.test.ts tests/play-pool-editor.test.ts tests/genio-unity.test.ts --testTimeout=30000 --maxWorkers=2
npm run typecheck
```

The tests exercise real robocopy on Windows, excluded paths, retry after failure,
disk rejection before writes, LFS sharing and logical size checks, telemetry,
and link refusal. They never create a real project slot or launch Unity.
