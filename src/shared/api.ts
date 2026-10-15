import type { ModelCatalogue } from './model-catalogue'
import type { RecommendationReview, RecommendationResult } from './choice'
import type { InventoryContext } from './inventory-context'
export interface WorldMetadata { engineVersion?: string; lastCommitAt?: string }

import type { AllyControlsPatch, UnqueuedChat } from './chat'
import type {
  AwayMode, AwayState, BacklogItem, StatusReport, ChatMessage, DeliveryMode, Engine, FleetSnapshot,
  GenioEvent, LedgerRecord, Priority, Project, ProjectCommands, Ally, Settings, Task, TaskKind,
  TerminalInfo, ToolStatus, UpdateInfo, Wake, Forge, Decision, InboxNote, ProjectMode, Loadout, LoadoutInput, TaskCategory, Verdict, PlaystyleId,
  ReactionKind
} from './types'
import type { DispatchScoresView } from './dispatch'
import type { ChatImageInput } from './chat-images'
import type { InventoryInfo, InventoryQuery, InventoryResult, InventoryState } from './inventory'
import type { UthanaWorldConfig, UthanaWorldState } from './uthana'

export interface SpawnRequest {
  kind: TaskKind
  project: string
  title: string
  /** The player's own words: becomes "## Player's intent" in the brief. */
  intent: string
  /** Genio's build instructions: becomes "## Genio spec". */
  spec?: string
  mode?: DeliveryMode
  yolo?: boolean
  baseBranch?: string
  harness?: string
  model?: string
  effort?: string
  /** dispatch category (Genio passes it; absent = keyword heuristic) */
  category?: TaskCategory
  backlogId?: string
  wksp?: string
}

export interface ProjectAddRequest {
  /** git URL, owner/repo shorthand, or a local folder path */
  source: string
  name?: string
  mode?: ProjectMode
  yolo?: boolean
  branchPrefix?: string
  forge?: Forge
  capacity?: number
  /** register an existing local folder in place rather than cloning */
  inPlace?: boolean
}

/** Local branch vs origin, as last fetched. `remoteMissing` = origin has no such branch yet. */
export interface PushStatus {
  branch: string
  ahead: number
  behind: number
  remoteMissing: boolean
}

export interface ProjectCreateRequest {
  name: string
  /** the scaffold (.gitignore, README, AGENTS.md); the project's engine is detected once its project files exist */
  engine: Engine
  description?: string
  mode?: ProjectMode
  /** create a GitHub repo too (needs the player's explicit consent: outward-facing) */
  createRemote?: boolean
  privateRemote?: boolean
}

export interface AllyCreateRequest {
  name: string
  scope: string
  charter: string
  projects: string[]
  model?: string
  effort?: string
}

export type TaskFile = 'brief' | 'report' | 'status' | 'inbox' | 'diff' | 'log' | 'validation'

export interface OpResult {
  ok: boolean
  message: string
}

export type LoginState = 'logged-in' | 'logged-out' | 'unknown'

/** A CLI with its own login (Systems → Accounts). Genio never holds its credentials. */
export interface AccountStatus {
  tool: string
  label: string
  purpose: string
  installed: boolean
  version?: string
  /** loadout install hint, shown when missing */
  install?: string
  state: LoginState
  /** account or auth method, as the CLI reports it (token-free) */
  detail?: string
  canLogin: boolean
  canLogout: boolean
  /** auth commands checked against the installed CLI's --help (else wired from its docs) */
  verified: boolean
  note?: string
  /** row-specific wording: chip text, button labels, and a warning shown under the row */
  stateLabel?: string
  loginLabel?: string
  logoutLabel?: string
  warning?: string
}

/** The Accounts row of Genio's own Codex home (signed in once more with the player's ChatGPT account). */
export const GENIO_CODEX = 'codex-genio'

/**
 * The login each runtime actually uses: Codex runs in Genio's own home once it
 * is signed in, so that row stands in for the player's own Codex login.
 */
export function runtimeAccounts(list: AccountStatus[]): AccountStatus[] {
  const genio = list.find(a => a.tool === GENIO_CODEX)
  if (genio?.state !== 'logged-in') return list
  return list.map(a => (a.tool === 'codex' ? { ...a, state: genio.state, detail: genio.detail } : a))
}

/**
 * Which session buttons an account row shows: only Log in when logged out, only Log out
 * when logged in, and both when the state could not be read.
 */
export function accountActions(a: Pick<AccountStatus, 'installed' | 'state' | 'canLogin' | 'canLogout'>): { login: boolean; logout: boolean } {
  if (!a.installed) return { login: false, logout: false }
  return {
    login: a.canLogin && a.state !== 'logged-in',
    logout: a.canLogout && a.state !== 'logged-out'
  }
}

/** One plan rate-limit window as the tool itself reported it. */
export interface UsageWindow {
  /** e.g. "5-hour", "weekly", "weekly (Opus)" */
  label: string
  /** 0-100; absent when the tool reported only a status */
  usedPercent?: number
  /** 'allowed' | 'allowed_warning' | 'rejected' (Claude Code only) */
  status?: string
  resetsAt?: string
  observedAt?: string
  changedAt?: string
  /** Diagnostic history only; never used to protect quota after expiry. */
  lastKnownUsedPercent?: number
  /** Observation expired or the reset time passed; current usage is unknown. */
  stale?: boolean
}

/** Plan / rate-limit status reported by the tool (never estimated by Genio). */
export interface UsageLimits {
  /** e.g. "reported by Codex" */
  source: string
  /** when the tool reported it */
  updatedAt: string
  /** limit bucket name when the tool has several (e.g. a model-specific limit) */
  name?: string
  plan?: string
  windows: UsageWindow[]
}

export interface TokenTally {
  /** uncached input (including cache writes) */
  input: number
  /** cache reads */
  cached: number
  output: number
  total: number
  sessions: number
}

/** Tokens Genio counted from the local session logs of its own units and chats. */
export interface MeasuredUsage {
  source: string
  updatedAt: string
  /** what was counted, e.g. "Genio units and chats (sessions under ~/.genio)" */
  scope: string
  today: TokenTally
  week: TokenTally
  /** project chat/Bot sessions and unit worktrees attributed to their world; legacy shared chat remains unattributed; measured tokens, not plan share */
  byWorld?: Record<string, { today: TokenTally; week: TokenTally }>
}

export interface ToolUsage {
  tool: string
  limits: UsageLimits[]
  measured?: MeasuredUsage
  /** where Genio looked when it found nothing to report */
  note?: string
  error?: string
}

export interface FalSpend {
  source: string
  updatedAt: string
  todayUsd: number
  weekUsd: number
  /** runs in the last 7 days, and how many of them have a cost recorded */
  runs: number
  costed: number
}

/** Systems → Accounts usage panel. Built from status output and local logs only. */
export interface UsageReport {
  generatedAt: string
  tools: ToolUsage[]
  fal: FalSpend
}

/** An API-key service; the key itself never crosses to the renderer. */
export interface ApiKeyStatus {
  id: string
  label: string
  purpose: string
  set: boolean
  last4?: string
  setAt?: string
}

export type FalRunStatus = 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type FalOutputKind = 'image' | 'audio' | 'video' | 'model' | 'other'

/** One file a FAL run produced. Genio keeps a local copy in its data dir. */
export interface FalOutput {
  kind: FalOutputKind
  /** where FAL serves it (https), or '' when FAL inlined it as a data URI */
  url: string
  /** JSON path in the result, e.g. images[0] */
  field: string
  fileName: string
  contentType?: string
  size?: number
  width?: number
  height?: number
  /** absolute path of the local copy */
  localPath?: string
  /** genio-media:// URL the renderer can load */
  mediaUrl?: string
  downloadError?: string
}

/** A FAL.ai queue request and what came back (generation history). */
export interface FalRun {
  id: string
  endpoint: string
  input: Record<string, unknown>
  status: FalRunStatus
  requestId?: string
  statusUrl?: string
  responseUrl?: string
  cancelUrl?: string
  queuePosition?: number
  /** last log lines FAL reported */
  logs: string[]
  error?: string
  outputs: FalOutput[]
  /** the result JSON (long strings trimmed) */
  result?: unknown
  /** only when FAL reports one */
  costUsd?: number
  /** Genio's pre-run estimate from the catalogue price (USD) */
  estUsd?: number
  /** the world it was generated for (undefined: Scratch, no world) */
  world?: string
  /** recipe it was launched from */
  recipe?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export interface FalRunRequest {
  /** Agent quote ceiling; service refuses changed/unknown pricing before submitting. */
  maxCostUsd?: number
  /** FAL endpoint id, e.g. fal-ai/flux/dev */
  endpoint: string
  /** string values "@file:<absolute path>" are sent as data URIs */
  input: Record<string, unknown>
  /** active world (omit for Scratch) */
  world?: string
  recipe?: string
}

export interface FalPrice {
  unitPrice: number
  /** FAL billing unit: images, megapixels, seconds, units, 1000 characters, ... */
  unit: string
  currency?: string
}

export type FalTier = 'core' | 'alt' | 'post'

/** One curated model (resources/fal-catalogue.json, plus a world's .genio/fal/catalogue.json). */
export interface FalCatalogueEntry {
  endpoint: string
  job: string
  tier: FalTier
  label: string
  /** one line: what to use it for */
  hint: string
  output: FalOutputKind
  /** file kind its main input takes, for "Use as input" */
  accepts?: FalOutputKind
  /** essentials: optional fields shown above More options */
  pin?: string[]
  /** Genio's game-friendly values for pinned fields */
  defaults?: Record<string, unknown>
  /** fields kept out of the form (JSON can still set them) */
  hide?: string[]
  /** price snapshot; live prices override it */
  price?: FalPrice
  /** billing units one typical run uses, for abstract units */
  unitsPerRun?: number
  /** human price text when the API unit is abstract */
  pagePrice?: string
  /** added by the world's own catalogue.json */
  fromWorld?: boolean
}

/** What FAL's models API says about an endpoint (cached a day in Genio's data). */
export interface FalModelInfo {
  endpoint: string
  name?: string
  category?: string
  description?: string
  /** FAL's metadata.status; undefined with listed=false means FAL no longer lists it */
  status?: string
  listed?: boolean
  thumbnail?: string
  license?: string
  /** resolved JSON schema of the endpoint input */
  schema?: Record<string, unknown>
  price?: FalPrice
  checkedAt: string
}

export interface FalCatalogue {
  jobs: { id: string; label: string }[]
  entries: FalCatalogueEntry[]
  info: Record<string, FalModelInfo>
  refreshedAt?: string
  refreshing: boolean
  /** last refresh problem (cached data still served) */
  error?: string
}

export interface FalSearchHit {
  endpoint: string
  name: string
  category?: string
  description?: string
  thumbnail?: string
}

export interface FalBudget {
  monthly_usd?: number
  confirm_over_usd?: number
}

/** <world>/.genio/fal/config.json */
export interface FalWorldConfig {
  schema?: string
  /** save folders per output kind, relative to the world root */
  folders?: Partial<Record<FalOutputKind, string>>
  budget?: FalBudget
  /** per-endpoint defaults that override the catalogue's */
  defaults?: Record<string, Record<string, unknown>>
  /** provider switches, e.g. {"codex": {"enabled": false}} to opt this world out of Codex images (on by default; read by unit helpers; kept as-is here) */
  providers?: Record<string, unknown>
  [k: string]: unknown
}

/** A named preset: per-world favourite (<world>/.genio/fal/recipes.json). */
export interface FalRecipe {
  id: string
  label: string
  endpoint: string
  input: Record<string, unknown>
  prompt_template?: string
  save_to?: FalOutputKind
  then?: string[]
}

export interface FalWorldState {
  /** null: Scratch (no world) */
  world: string | null
  config: FalWorldConfig
  recipes: FalRecipe[]
  /** estimated USD this calendar month (spend.jsonl + unsaved runs) */
  spentUsd: number
  month: string
  /** the world already has a .genio/ folder */
  hasGenioDir: boolean
  engineRoot?: string
  engine?: Engine
}

export interface FalSaveRequest {
  by?: string
  runId: string
  output: number
  project: string
  /** folder relative to the world root ('' = root) */
  folder: string
  fileName: string
  overwrite?: boolean
}

export interface FalSaveResult extends OpResult {
  /** the target exists and overwrite was not confirmed */
  exists?: boolean
  path?: string
  /** world-relative provenance file written next to the save */
  provenance?: string
  /** e.g. Git LFS does not cover this file type */
  warnings?: string[]
}

export interface GenioApi {
  /** Settings › This project › Unity slots: the shared slot pool. */
  playPool(world: string): Promise<import('./play').PlayPoolState>
  /** Applies at once; returns the slots left draining above a lowered cap. */
  playPoolCap(world: string, cap: number): Promise<{ cap: number; draining: number[] }>
  /** Slot editors on Genio's hidden desktop (default) or as visible windows, for debugging; applies to the next launch. */
  playPoolLaunch(world: string, visible: boolean): Promise<{ launch: 'hidden' | 'visible' }>
  playPoolEstimate(world: string): Promise<number>
  /** Bytes each existing slot copy uses, by slot id. */
  playPoolDisk(world: string): Promise<Record<number, number>>
  /** Close a slot's Unity editor safely; revokes a unit's lease on that slot (the player confirmed). */
  playCloseSlotEditor(world: string, id: number): Promise<void>
  /** The player's own Play copies, one per project; a project window sees only its own. */
  playerCopies(): Promise<import('./play').PlayerCopyRecord[]>
  /** This project's copy record, or null. */
  playerCopyStatus(world: string): Promise<import('./play').PlayerCopyRecord | null>
  /** Create (or revive a copy waiting to be deleted); the first sync seeds it. */
  playerCopyEnsure(world: string): Promise<import('./play').PlayerCopyRecord>
  /** Mirror a checkout of the project or a branch into the copy; reports changes and whether Unity must restart. */
  playerCopySync(world: string, source: import('./play').PlayerCopySource): Promise<import('./play').PlayerSyncReport>
  /** Stop a running sync between files; true when one was running. */
  playerCopyCancel(world: string): Promise<boolean>
  /** Delete the copy in the background; it stays 'pending-delete' while Unity holds it. */
  playerCopyDelete(world: string): Promise<{ deleted: boolean; record?: import('./play').PlayerCopyRecord }>
  /** Disk the copy uses by part, or the first copy's estimate. */
  playerCopySizes(world: string): Promise<import('./play').PlayerCopySizes>
  playerInstanceStatus(world: string): Promise<import('./play').PlayerInstanceStatus>
  playerInstancePlay(world: string, source: import('./play').PlayerCopySource, options?: { startAnyway?: boolean; visible?: boolean; scene?: string }): Promise<import('./play').PlayerInstanceStatus>
  playerInstanceStop(world: string): Promise<import('./play').PlayerInstanceStatus>
  playerInstanceQuit(world: string): Promise<import('./play').PlayerInstanceStatus>
  playerInstanceRestart(world: string, visible?: boolean): Promise<import('./play').PlayerInstanceStatus>
  playerInstanceKeepAlive(world: string): Promise<import('./play').PlayerInstanceStatus>
  playerInstanceDetach(world: string): Promise<import('./play').PlayerInstanceStatus>
  playerInstanceSettings(world: string, patch: Partial<import('./play').PlayerSettings>): Promise<import('./play').PlayerSettings>
  playerInstanceMachine(world: string): Promise<import('./play').PlayerMachineStatus>
  playerInstanceConsole(world: string, cursor?: number, session?: string): Promise<import('./play').PlayConsole>
  /** Transfers a frame/input MessagePort to the owning window. No Pipeline or WebSocket credentials cross IPC. */
  playerInstanceStream(world: string, enabled: boolean, width?: number, height?: number): Promise<void>
  /** The hidden desktop's screenshot taken when a dialog blocked the player editor (PNG data URL), if any. */
  playerInstanceDialogShot(world: string): Promise<string | undefined>
  /** The Play screen's sources: main checkout, worktrees, units' worktrees by name, branches. */
  playerSources(world: string): Promise<import('./play').PlayerSourceOption[]>
  /** Open starts the watcher and returns the cache while reconciling in background. */
  inventoryOpen(world: string): Promise<InventoryState>
  inventoryClose(world: string): Promise<void>
  /** Call on window focus too, for platforms where recursive watching is unavailable. */
  inventoryRefresh(world: string): Promise<InventoryState>
  inventoryList(world: string, query?: InventoryQuery): Promise<InventoryResult>
  inventoryInfo(world: string, path: string, verifyHash?: boolean): Promise<InventoryInfo | null>
  featureUsed(feature: 'screenshot' | 'model-picker' | 'character-sheet' | 'play-fullscreen'): Promise<void>
  /** Character Sheet: pin an unlocked achievement to the front of the grid (three at most) */
  trophyPin(id: string, pinned: boolean): Promise<OpResult>
  /** Character Sheet: equip an earned playstyle title; null follows the current playstyle */
  titleEquip(id: PlaystyleId | null): Promise<OpResult>
  snapshot(): Promise<FleetSnapshot>
  homePath(): Promise<string>
  getSettings(): Promise<Settings>
  explorerStatus(): Promise<ExplorerStatus>
  explorerSet(enabled: boolean): Promise<ExplorerStatus>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  toolchain(): Promise<ToolStatus[]>
  installTool(name: string): Promise<OpResult>
  pickDirectory(): Promise<string | null>
  /** File menu: registered projects and every open window (project null = the Hub) */
  windowList(): Promise<WindowList>
  /** File menu: focus the Hub, opening it when closed */
  windowOpenHub(): Promise<void>
  /** File menu: close the calling window through its usual unit guard */
  windowClose(): Promise<void>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>

  // ---- accounts
  modelCatalogue(refresh?: boolean): Promise<ModelCatalogue>
  accounts(): Promise<AccountStatus[]>
  /** runs the tool's own login/logout in a visible terminal */
  accountSession(tool: string, action: 'login' | 'logout'): Promise<TerminalInfo>
  /** plan limits reported by the CLIs plus usage Genio measured from local session logs */
  accountUsage(): Promise<UsageReport>
  /** Usage mode, what it resolves to, protection levels, the shared plan meter and quests waiting for a reset (cached local evidence) */
  usagePolicy(): Promise<import('./usage-mode').UsagePolicyView>
  apiKeys(): Promise<ApiKeyStatus[]>
  apiKeySet(id: string, key: string): Promise<OpResult>
  apiKeyClear(id: string): Promise<OpResult>
  /** Housekeeping dry run: Genio's past Codex threads and Claude folders in the player's own homes */
  sessionCleanupPreview(): Promise<SessionCleanupPreview>
  /** archive / move the previewed items with these keys; never deletes, recorded for Undo */
  sessionCleanupRun(keys: string[]): Promise<SessionCleanupResult>
  sessionCleanupProgress(): Promise<SessionCleanupProgress>
  /** restore everything the housekeeping manifest lists */
  sessionCleanupUndo(): Promise<SessionCleanupResult>

  // ---- per-world generation settings
  falWorld(world: string | null): Promise<FalWorldState>
  falWorldConfig(world: string | null, config: FalWorldConfig): Promise<FalWorldState>
  uthanaWorld(world: string | null): Promise<UthanaWorldState>
  uthanaWorldConfig(world: string | null, config: UthanaWorldConfig): Promise<UthanaWorldState>

  // ---- bridge (chat with Genio / second units)
  approveGeneration(wksp: string, run: string): Promise<import('./generation').GenerationCard>
  chatHistory(wksp: string, limit?: number): Promise<ChatMessage[]>
  /** images go to the session as image blocks; text may be empty when images are attached */
  sendChat(wksp: string, text: string, images?: ChatImageInput[], context?: InventoryContext): Promise<void>
  /** take back a queued (or unsent) message for edit/cancel; null when the session already picked it up */
  unqueueChat(wksp: string, id: string): Promise<UnqueuedChat | null>
  /** like/dislike a Genio message (null removes it); a dislike pauses what that message started after a short grace period */
  reactToMessage(wksp: string, id: string, kind: ReactionKind | null): Promise<ChatMessage>
  interruptWksp(wksp: string): Promise<void>
  restartWksp(wksp: string, fresh: boolean, role?: 'genio' | 'bot'): Promise<void>
  resolvePermission(id: string, allow: boolean): Promise<void>
  recap(): Promise<void>
  save(): Promise<void>

  // ---- crew
  spawnTask(req: SpawnRequest): Promise<Task>
  /** What a deploy with these fields would get (harness, model, effort) and why. */
  previewLoadout(req: LoadoutInput): Promise<Loadout>
  /** the player's 👍/👎 on a unit (scorecard) */
  rateTask(id: string, verdict: Verdict, note?: string): Promise<OpResult>
  /** Systems → Dispatch: learned scores, recent outcomes, learning log */
  dispatchScores(): Promise<DispatchScoresView>
  sendToTask(id: string, text: string, resolveKey?: string): Promise<OpResult>
  controlTask(id: string, action: 'interrupt' | 'exit' | 'relaunch'): Promise<OpResult>
  cleanupTask(id: string, force?: boolean): Promise<OpResult>
  mergeTask(id: string): Promise<OpResult>
  promoteScout(id: string, intent?: string): Promise<Task>
  readTaskFile(id: string, which: TaskFile): Promise<string>

  // ---- terminals
  terminals(): Promise<TerminalInfo[]>
  terminalAttach(id: string): Promise<string>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  /** A shell in `cwd`, or in a unit's copy and tied to that unit (`taskId`): Despawn closes it. */
  terminalOpenShell(cwd?: string, taskId?: string): Promise<TerminalInfo>
  terminalKill(id: string): Promise<void>

  // ---- quest log (backlog)
  backlogAdd(item: Partial<BacklogItem> & { title: string }): Promise<BacklogItem>
  backlogUpdate(id: string, patch: Partial<BacklogItem>): Promise<BacklogItem>
  backlogHold(id: string, reason: string, until?: string): Promise<BacklogItem>
  backlogRelease(id: string): Promise<BacklogItem>
  backlogDispatch(id: string): Promise<OpResult>
  backlogRemove(id: string): Promise<void>
  /** persist a manual queue order: each quest's priority band and rank within it */
  backlogReorder(patches: { id: string; priority: Priority; rank: number }[]): Promise<BacklogItem[]>

  // ---- decisions
  answerDecision(id: string, answer: string): Promise<OpResult>
  clarifyDecision(id: string, question: string): Promise<OpResult>
  applyRecommendations(review: RecommendationReview[]): Promise<RecommendationResult[]>
  deferDecision(id: string, until: string): Promise<void>
  addDecision(d: Partial<Decision> & { question: string }): Promise<Decision>

  // ---- projects
  projectAdd(req: ProjectAddRequest): Promise<Project>
  projectOpen(folder: string): Promise<void>
  projectCreate(req: ProjectCreateRequest): Promise<Project>
  projectUpdate(name: string, patch: Partial<Project> & { commands?: ProjectCommands }): Promise<Project>
  projectRemove(name: string, deleteClone: boolean): Promise<OpResult>
  projectSync(name?: string): Promise<OpResult>
  /** re-detect the project's engine now (Rescan); the entry carries what the scan found in detected */
  projectRescan(name: string): Promise<Project>
  /** commits on the local default branch not yet on origin (Offline worlds with a remote) */
  projectMetadata(name: string): Promise<WorldMetadata>
  projectPushStatus(name: string): Promise<PushStatus | undefined>
  /** guarded, never-forced push of the default (or a named) branch to origin */
  projectPush(name: string, branch?: string): Promise<OpResult>

  // ---- debrief / modes / memory
  statusReport(opts: { file: boolean; includePRs: boolean }): Promise<StatusReport>
  setAway(mode: AwayMode): Promise<AwayState>
  readMemory(which: MemoryFile): Promise<string>
  writeMemory(which: MemoryFile, content: string): Promise<void>
  /** estimated tokens per memory file against the budget, plus expired entries */
  memoryReport(): Promise<MemoryReport>
  /** move entries (exact lines, as listed by memoryReport) into the memory archive */
  memoryArchive(entries: string[], reason: string): Promise<void>
  inboxSubmit(text: string, from?: string): Promise<InboxNote>
  inboxAck(id: string): Promise<void>
  ledgerTail(n: number): Promise<LedgerRecord[]>
  wakes(n: number): Promise<Wake[]>

  // ---- second units
  allyCreate(req: AllyCreateRequest): Promise<Ally>
  allyRetire(name: string): Promise<OpResult>
  /** save an ally chat's own approval mode / model / effort ('' = follow the main chat) */
  allyUpdate(name: string, patch: AllyControlsPatch): Promise<Ally>

  // ---- self update
  checkUpdate(): Promise<UpdateInfo>
  applyUpdate(): Promise<OpResult>
}

export interface ExplorerStatus { available: boolean; installed: boolean; present: boolean }
export interface SessionCleanupItem { key: string; app: 'codex' | 'claude'; label: string; detail: string }
export interface SessionCleanupPreview {
  /** Codex threads to archive */
  codex: SessionCleanupItem[]
  /** Claude folders to move into Genio's own Claude folder */
  claude: SessionCleanupItem[]
  /** Genio's, but left alone (running now, or nowhere safe to move) */
  skipped: (SessionCleanupItem & { reason: string })[]
  /** manifest entries Undo would restore */
  undoable: number
  manifest: string
}
export interface SessionCleanupProgress { running: boolean; action?: 'hide' | 'undo'; step: string; done: number; total: number }
export interface SessionCleanupResult {
  ok: boolean
  message: string
  archived: number
  moved: number
  restored: number
  skipped: { label: string; reason: string }[]
  /** why the Codex part stopped early */
  aborted?: string
  manifest: string
}
export interface WindowList {
  projects: Pick<Project, 'name' | 'path' | 'addedAt'>[]
  windows: { project: string | null; current: boolean }[]
}
export type MemoryFile = 'player' | 'lore' | 'player-shared'
export interface MemoryReport { tokens: number; budget: number; overBudget: boolean; stale: string[]; files: { file: string; tokens: number }[] }

export type ApiMethod = keyof GenioApi
/** Every GenioApi method, as runtime data (contextBridge cannot clone a Proxy). */
export const API_METHODS = [
  'playPool', 'playPoolCap', 'playPoolLaunch', 'playPoolEstimate', 'playPoolDisk', 'playCloseSlotEditor',
  'playerInstanceStatus', 'playerInstancePlay', 'playerInstanceStop', 'playerInstanceQuit', 'playerInstanceRestart', 'playerInstanceKeepAlive', 'playerInstanceDetach', 'playerInstanceSettings', 'playerInstanceMachine', 'playerInstanceConsole', 'playerInstanceStream', 'playerInstanceDialogShot', 'playerSources',
  'playerCopies', 'playerCopyStatus', 'playerCopyEnsure', 'playerCopySync', 'playerCopyCancel', 'playerCopyDelete', 'playerCopySizes',
  'inventoryOpen', 'inventoryClose', 'inventoryRefresh', 'inventoryList', 'inventoryInfo',
  'featureUsed',
  'trophyPin',
  'titleEquip',
  'snapshot',
  'homePath',
  'getSettings',
  'explorerStatus',
  'explorerSet',
  'saveSettings',
  'toolchain',
  'installTool',
  'pickDirectory',
  'windowList',
  'windowOpenHub',
  'windowClose',
  'openPath',
  'openExternal',
  'modelCatalogue',
  'accounts',
  'accountSession',
  'accountUsage',
  'usagePolicy',
  'apiKeys',
  'apiKeySet',
  'apiKeyClear',
  'sessionCleanupPreview',
  'sessionCleanupRun',
  'sessionCleanupProgress',
  'sessionCleanupUndo',
  'falWorld',
  'falWorldConfig',
  'uthanaWorld',
  'uthanaWorldConfig',
  'approveGeneration',
  'chatHistory',
  'sendChat',
  'unqueueChat',
  'reactToMessage',
  'interruptWksp',
  'restartWksp',
  'resolvePermission',
  'recap',
  'save',
  'spawnTask',
  'previewLoadout',
  'rateTask',
  'dispatchScores',
  'sendToTask',
  'controlTask',
  'cleanupTask',
  'mergeTask',
  'promoteScout',
  'readTaskFile',
  'terminals',
  'terminalAttach',
  'terminalWrite',
  'terminalResize',
  'terminalOpenShell',
  'terminalKill',
  'backlogAdd',
  'backlogUpdate',
  'backlogHold',
  'backlogRelease',
  'backlogDispatch',
  'backlogRemove',
  'backlogReorder',
  'answerDecision',
  'clarifyDecision',
  'applyRecommendations',
  'deferDecision',
  'addDecision',
  'projectAdd',
  'projectOpen',
  'projectCreate',
  'projectUpdate',
  'projectRemove',
  'projectSync',
  'projectRescan',
  'projectMetadata',
  'projectPushStatus',
  'projectPush',
  'statusReport',
  'setAway',
  'readMemory',
  'writeMemory',
  'memoryReport',
  'memoryArchive',
  'inboxSubmit',
  'inboxAck',
  'ledgerTail',
  'wakes',
  'allyCreate',
  'allyRetire',
  'allyUpdate',
  'checkUpdate',
  'applyUpdate'
] as const satisfies readonly ApiMethod[]

// Compile-time guard: fails if a GenioApi method is missing from API_METHODS.
type MissingApiMethod = Exclude<ApiMethod, (typeof API_METHODS)[number]>
export const API_METHODS_COMPLETE: [MissingApiMethod] extends [never] ? true : MissingApiMethod = true
export const API_PREFIX = 'genio:'
export const EVENT_CHANNEL = 'genio:event'
export const PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low']

export type { GenioEvent }
