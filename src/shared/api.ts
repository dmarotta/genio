import type {
  AwayMode, AwayState, BacklogItem, StatusReport, ChatMessage, DeliveryMode, Engine, FleetSnapshot,
  GenioEvent, LedgerRecord, Priority, Project, ProjectCommands, Ally, Settings, Task, TaskKind,
  TerminalInfo, ToolStatus, UpdateInfo, Wake, Forge, Decision, InboxNote, ProjectMode, Loadout, LoadoutInput
} from './types'

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

/** An API-key service; the key itself never crosses to the renderer. */
export interface ApiKeyStatus {
  id: string
  label: string
  purpose: string
  set: boolean
  last4?: string
  setAt?: string
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
  apiKeys(): Promise<ApiKeyStatus[]>
  apiKeySet(id: string, key: string): Promise<OpResult>
  apiKeyClear(id: string): Promise<OpResult>

  // ---- bridge (chat with Genio / second units)
  chatHistory(wksp: string, limit?: number): Promise<ChatMessage[]>
  sendChat(wksp: string, text: string): Promise<void>
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
  'apiKeys',
  'apiKeySet',
  'apiKeyClear',
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
