import type { Project } from '../src/shared/types'

/**
 * Stored registry entries that every engine consumer must read the same way. The fixture world has
 * Unity at FoundersOfAvalonUnity/ on disk, so a consumer that re-detected would disagree with `root`/`play`.
 * Shared by the main-process contract (engine-contract.test.ts) and the renderer gate (play-availability.test.ts).
 */
export const ENGINE_CASES: { name: string; stored: Partial<Project>; play: boolean; root: string }[] = [
  { name: 'a nested root (founders-of-avalon)', stored: { engine: 'unity', engineRoot: 'FoundersOfAvalonUnity' }, play: true, root: 'FoundersOfAvalonUnity' },
  { name: 'a stored root that differs from the scan (declared in .genio/project.json)', stored: { engine: 'unity', engineRoot: 'Manual/Game' }, play: true, root: 'Manual/Game' },
  { name: 'the repository root', stored: { engine: 'unity', engineRoot: '' }, play: true, root: '' },
  { name: 'a legacy entry without a root', stored: { engine: 'unity' }, play: true, root: '' },
  { name: 'a root stored with Windows separators', stored: { engine: 'unity', engineRoot: 'FoundersOfAvalonUnity\\' }, play: true, root: 'FoundersOfAvalonUnity' },
  { name: 'a stored non-game engine over Unity on disk', stored: { engine: 'other', engineRoot: '' }, play: false, root: '' },
  { name: 'a stored Godot engine at a nested root', stored: { engine: 'godot', engineRoot: 'game' }, play: false, root: 'game' }
]

export const engineProject = (stored: Partial<Project>, path: string): Project => ({
  name: 'game', path, defaultBranch: 'main', engine: 'other', commands: {},
  mode: 'local-only', yolo: false, forge: 'none', branchPrefix: 'genio/', managed: false, addedAt: '', ...stored
})
