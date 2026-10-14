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
when skipped, or `'submodules-missing' | 'source-submodules-missing'` (with the
`missing` paths) when the copy or the source project declares git submodules
under the Unity root that are not checked out. A completed seed also reports `method`, `bytes`, `files`,
`estimatedBytes`, `requiredBytes`, and `availableBytes`. `genio-unity` records
this as `librarySeed` in result.json and keeps the existing `librarySeeded`
boolean. Play pool state.json and its state API expose `slot.preparation` with
the Library report, total elapsed time, preflight and Git phase times, actual
slot bytes/files, the preflight estimate/free space, and the shared LFS path.

## Dev Drive block cloning

`copyLibrary` runs behind `cloneOrCopyLibrary`
(`resources/unit-skills/genio/skills/play/scripts/clone.mjs`). On Windows it first
asks whether the source Library and the staging directory sit on one fixed volume
that reports `FILE_SUPPORTS_BLOCK_REFCOUNTING` (ReFS, Dev Drive). The system drive
is never ReFS, so a project on C: skips the probe and goes straight to robocopy:
plain NTFS behaves exactly as above.

- Windows 11 24H2 (build 26100) or later: Node's `fs.copyFile` uses `CopyFile`,
  which clones by itself on ReFS.
- Earlier builds: a small C# helper (compiled by Windows PowerShell `Add-Type`)
  calls `FSCTL_DUPLICATE_EXTENTS_TO_FILE` per file, in cluster-aligned 1 GiB
  ranges, keeping sparseness, integrity streams and write times. Files under
  4 KB are copied normally. A file the volume refuses to clone is copied instead.
- The first clone on each volume is checked once with
  `fsutil file queryExtentsAndRefCounts` on the largest cloned file. The answer is
  kept per volume GUID in `<data>/clone-volumes.json`; a volume that shows no
  shared blocks, or refuses every clone, stays on robocopy from then on.
- Any probe failure, clone failure (the partial staging copy is removed first) or
  missing drive falls back to robocopy. The seed report adds `method`
  (`clone:copyfile`, `clone:fsctl`, `robocopy`, ...) and `clone.reason` when the
  clone path was not used.

Cloning needs the copies on the project's volume. When a project's own drive block
clones and Genio's base lives elsewhere, Play slots go to
`<drive>\.genio\<key>\play-pools\<pool>` (decided once per pool, recorded in the
pool folder's `placement.json`; lease state stays in Genio's data folder) and new
unit worktrees go to `<drive>\.genio\<key>\worktrees\<world>\<id>`. A pool that
already has slots keeps them where they are. Genio never creates, mounts, resizes
or formats a volume. If a project's drive is not mounted (a Dev Drive VHDX not
re-attached after a reboot), Genio says so and asks for Disk Management >
Action > Attach VHD. Free-space prechecks still budget the full logical size,
because clones reserve no space for later writes.

### Final check on the real drive (manual)

Fixtures cover the logic; the real-volume check needs the player's Dev Drive.
Once the projects are on it, run from the Genio checkout:

```text
node scripts/dev-drive-check.mjs D:\git\lands-of-old --library D:\git\lands-of-old\Library
```

It prints the Windows build and clone method, where slots and worktrees will go,
the volume's file system and cluster size, clones an 8 MiB scratch file, confirms
shared blocks with fsutil, and (with `--library`) times a real Library seed
through `seedLibrary`. It writes only under `<drive>\.genio\dev-drive-check-*` and
deletes that again. `PASSED` (exit 0) means Genio will clone on that drive.

Verification uses temporary repositories and trees only:

```text
npx vitest run tests/unity-seed.test.ts tests/dev-drive-clone.test.ts tests/play-pool.test.ts tests/play-pool-editor.test.ts tests/genio-unity.test.ts --testTimeout=30000 --maxWorkers=2
npm run typecheck
```

The tests exercise real robocopy on Windows, excluded paths, retry after failure,
disk rejection before writes, LFS sharing and logical size checks, telemetry,
and link refusal. They never create a real project slot or launch Unity.
