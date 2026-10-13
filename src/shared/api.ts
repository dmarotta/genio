import type {
  AwayMode, AwayState, BacklogItem, StatusReport, ChatMessage, DeliveryMode, Engine, FleetSnapshot,
  GenioEvent, LedgerRecord, Priority, Project, ProjectCommands, Ally, Settings, Task, TaskKind,
  TerminalInfo, ToolStatus, UpdateInfo, Wake, Forge, Decision, InboxNote, ProjectMode, Loadout, LoadoutInput
} from './types'
import type { ChatImageInput } from './chat-images'

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

export interface ProjectCreateRequest {
  name: string
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
  /** the reset time has passed since this snapshot: the figure is out of date */
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

/** A FAL.ai queue request and what came back (FAL screen history). */
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
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export interface FalRunRequest {
  /** FAL endpoint id, e.g. fal-ai/flux/dev */
  endpoint: string
  input: Record<string, unknown>
}

export interface FalSaveRequest {
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
}

export interface GenioApi {
  snapshot(): Promise<FleetSnapshot>
  homePath(): Promise<string>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  toolchain(): Promise<ToolStatus[]>
  installTool(name: string): Promise<OpResult>
  pickDirectory(): Promise<string | null>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>

  // ---- accounts
  accounts(): Promise<AccountStatus[]>
  /** runs the tool's own login/logout in a visible terminal */
  accountSession(tool: string, action: 'login' | 'logout'): Promise<TerminalInfo>
  /** plan limits reported by the CLIs plus usage Genio measured from local session logs */
  accountUsage(): Promise<UsageReport>
  apiKeys(): Promise<ApiKeyStatus[]>
  apiKeySet(id: string, key: string): Promise<OpResult>
  apiKeyClear(id: string): Promise<OpResult>

  // ---- FAL.ai (runs in main with the stored key; the key never reaches the renderer)
  falRuns(): Promise<FalRun[]>
  falRun(req: FalRunRequest): Promise<FalRun>
  falCancel(id: string): Promise<OpResult>
  falDelete(id: string): Promise<OpResult>
  falSave(req: FalSaveRequest): Promise<FalSaveResult>
  /** folder picker rooted at a world; returns the path relative to it */
  falPickFolder(project: string): Promise<string | null>

  // ---- bridge (chat with Genio / second units)
  chatHistory(wksp: string, limit?: number): Promise<ChatMessage[]>
  /** images go to the session as image blocks; text may be empty when images are attached */
  sendChat(wksp: string, text: string, images?: ChatImageInput[]): Promise<void>
  interruptWksp(wksp: string): Promise<void>
  restartWksp(wksp: string, fresh: boolean): Promise<void>
  resolvePermission(id: string, allow: boolean): Promise<void>
  recap(): Promise<void>
  save(): Promise<void>

  // ---- crew
  spawnTask(req: SpawnRequest): Promise<Task>
  /** What a deploy with these fields would get (harness, model, effort) and why. */
  previewLoadout(req: LoadoutInput): Promise<Loadout>
  sendToTask(id: string, text: string, resolveKey?: string): Promise<OpResult>
  controlTask(id: string, action: 'interrupt' | 'exit' | 'relaunch'): Promise<OpResult>
  cleanupTask(id: string, force?: boolean): Promise<OpResult>
  mergeTask(id: string): Promise<OpResult>
  promoteScout(id: string, intent?: string): Promise<Task>
  validateTask(id: string): Promise<OpResult>
  readTaskFile(id: string, which: TaskFile): Promise<string>
  crewState(id: string): Promise<string>
  playtest(target: { taskId?: string; project?: string }): Promise<TerminalInfo | null>

  // ---- terminals
  terminals(): Promise<TerminalInfo[]>
  terminalAttach(id: string): Promise<string>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalOpenShell(cwd?: string): Promise<TerminalInfo>
  terminalKill(id: string): Promise<void>

  // ---- quest log (backlog)
  backlogAdd(item: Partial<BacklogItem> & { title: string }): Promise<BacklogItem>
  backlogUpdate(id: string, patch: Partial<BacklogItem>): Promise<BacklogItem>
  backlogHold(id: string, reason: string, until?: string): Promise<BacklogItem>
  backlogRelease(id: string): Promise<BacklogItem>
  backlogDispatch(id: string): Promise<OpResult>
  backlogRemove(id: string): Promise<void>

  // ---- decisions
  answerDecision(id: string, answer: string): Promise<OpResult>
  deferDecision(id: string, until: string): Promise<void>
  addDecision(d: Partial<Decision> & { question: string }): Promise<Decision>

  // ---- projects
  projectAdd(req: ProjectAddRequest): Promise<Project>
  projectCreate(req: ProjectCreateRequest): Promise<Project>
  projectUpdate(name: string, patch: Partial<Project> & { commands?: ProjectCommands }): Promise<Project>
  projectRemove(name: string, deleteClone: boolean): Promise<OpResult>
  projectSync(name?: string): Promise<OpResult>

  // ---- debrief / modes / memory
  statusReport(opts: { file: boolean; includePRs: boolean }): Promise<StatusReport>
  setAway(mode: AwayMode): Promise<AwayState>
  readMemory(which: MemoryFile): Promise<string>
  writeMemory(which: MemoryFile, content: string): Promise<void>
  inboxSubmit(text: string, from?: string): Promise<InboxNote>
  inboxAck(id: string): Promise<void>
  ledgerTail(n: number): Promise<LedgerRecord[]>
  wakes(n: number): Promise<Wake[]>

  // ---- second units
  allyCreate(req: AllyCreateRequest): Promise<Ally>
  allyRetire(name: string): Promise<OpResult>

  // ---- self update
  checkUpdate(): Promise<UpdateInfo>
  applyUpdate(): Promise<OpResult>
}

export type MemoryFile = 'player' | 'lore' | 'player-shared'

export type ApiMethod = keyof GenioApi
/** Every GenioApi method, as runtime data (contextBridge cannot clone a Proxy). */
export const API_METHODS = [
  'snapshot',
  'homePath',
  'getSettings',
  'saveSettings',
  'toolchain',
  'installTool',
  'pickDirectory',
  'openPath',
  'openExternal',
  'accounts',
  'accountSession',
  'accountUsage',
  'apiKeys',
  'apiKeySet',
  'apiKeyClear',
  'falRuns',
  'falRun',
  'falCancel',
  'falDelete',
  'falSave',
  'falPickFolder',
  'chatHistory',
  'sendChat',
  'interruptWksp',
  'restartWksp',
  'resolvePermission',
  'recap',
  'save',
  'spawnTask',
  'previewLoadout',
  'sendToTask',
  'controlTask',
  'cleanupTask',
  'mergeTask',
  'promoteScout',
  'validateTask',
  'readTaskFile',
  'crewState',
  'playtest',
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
  'answerDecision',
  'deferDecision',
  'addDecision',
  'projectAdd',
  'projectCreate',
  'projectUpdate',
  'projectRemove',
  'projectSync',
  'statusReport',
  'setAway',
  'readMemory',
  'writeMemory',
  'inboxSubmit',
  'inboxAck',
  'ledgerTail',
  'wakes',
  'allyCreate',
  'allyRetire',
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
