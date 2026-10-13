/**
 * Service contracts. Every main-process module implements one of these
 * interfaces and reaches its collaborators only through `AppCtx` / `HomeCtx`,
 * resolved lazily at call time (never captured at construction), so modules
 * can be built and tested independently.
 *
 * Global services live once on AppCtx. Home-scoped services exist per home:
 * the main home ('main') and one per local second unit.
 */
import type {
  AwayMode, AwayEntry, AwayState, BacklogItem, StatusReport, ChatMessage, Decision, FleetSnapshot,
  FleetStats, HarnessAdapter, InboxNote, LedgerRecord, WkspInfo, PermissionRequest, Project, Ally,
  Settings, StatusEvent, Task, TerminalInfo, ToolStatus, UpdateInfo, Wake, WakeKind, Achievement,
  DeliveryMode, SfxName, NotifyTarget
} from '@shared/types'
import type {
  OpResult, ProjectAddRequest, ProjectCreateRequest, AllyCreateRequest, SpawnRequest, TaskFile, MemoryFile,
  FalRun, FalRunRequest, FalSaveRequest, FalSaveResult
} from '@shared/api'
import type { AllyControlsPatch } from '@shared/chat'
import type { ChatImageInput } from '@shared/chat-images'
import type { Home } from './home'

// ---------------------------------------------------------------- global

export interface SettingsService {
  get(): Settings
  save(patch: Partial<Settings>): Settings
  harness(id: string): HarnessAdapter | undefined
  /** verified + enabled adapters whose command resolves on this machine */
  availableHarnesses(): HarnessAdapter[]
}

export interface ProjectsService {
  list(): Project[]
  get(name: string): Project | undefined
  add(req: ProjectAddRequest): Promise<Project>
  create(req: ProjectCreateRequest): Promise<Project>
  update(name: string, patch: Partial<Project>): Project
  /** preflight refuses while work is in flight/queued or unlanded worktrees exist */
  remove(name: string, deleteClone: boolean): Promise<OpResult>
  /** guarded fleet sync (fast-forward default branch, prune merged gone branches) */
  sync(name?: string): Promise<OpResult>
  /** resolve the concrete delivery posture for a task (mode never guessed). */
  resolvePosture(name: string, opts?: { mode?: DeliveryMode; yolo?: boolean; surface?: 'product' | 'internal' }): {
    mode: DeliveryMode
    yolo: boolean
    branchPrefix: string
    warning?: string
  }
  /** rebuild registry entries from clones on disk */
  reconcile(): Promise<void>
}

export interface CreateTerminalOpts {
  kind: TerminalInfo['kind']
  title: string
  cwd: string
  /** executable + args; when omitted the configured shell is started */
  file?: string
  args?: string[]
  env?: Record<string, string>
  taskId?: string
  cols?: number
  rows?: number
}

export interface TerminalService {
  create(opts: CreateTerminalOpts): TerminalInfo
  list(): TerminalInfo[]
  get(id: string): TerminalInfo | undefined
  write(id: string, data: string): void
  /** type text then press the submit key, with a short settle delay (TUI paste safety) */
  submit(id: string, text: string, submitKey?: string): Promise<void>
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  /** raw scrollback (ANSI) for re-attaching a view */
  scrollback(id: string): string
  /** last N lines as plain text (ANSI stripped) */
  tail(id: string, lines: number): string
  lastOutputAt(id: string): number | undefined
  onData(id: string, fn: (data: string) => void): () => void
  onExit(id: string, fn: (code: number) => void): () => void
  /** every terminal's output (index.ts batches this to the renderer on 'genio:term-data') */
  onAnyData(fn: (id: string, data: string) => void): () => void
}

export interface AwayService {
  state(): AwayState
  set(mode: AwayMode): Promise<AwayState>
  /** an escalation produced while DND/AFK: held for return + pushed to notifiers */
  capture(entry: Omit<AwayEntry, 'ts' | 'delivered'>): void
  /** builds the return brief text from held entries and marks them delivered */
  takeReturnBrief(): string
}

export interface NotifyOptions {
  /** what clicking the notification opens */
  target?: NotifyTarget
  /** show even when desktop notifications are switched off (AFK alarm) */
  force?: boolean
}

export interface NotifierService {
  /** title/body should come from formatNotification (notify-format.ts) */
  notify(title: string, body: string, severity: 'info' | 'decision' | 'failure' | 'ready', opts?: NotifyOptions): void
  sfx(name: SfxName): void
}

export interface InboxService {
  list(): InboxNote[]
  submit(text: string, from?: string): InboxNote
  ack(id: string): void
  reply(id: string, text: string): void
  /** starts/stops the optional local HTTP mail intake (token protected) */
  configure(): void
}

export interface LedgerService {
  record(rec: Omit<LedgerRecord, 'v' | 'ts' | 'home'> & { home?: string }): void
  tail(n: number): LedgerRecord[]
}

export interface StatsService {
  get(): FleetStats
  /** award xp for an event; unlocks achievements; publishes stats */
  award(event: 'spawn' | 'ship' | 'merge' | 'scout' | 'decision' | 'cleanup' | 'save', taskId?: string): void
  addCost(usd: number): void
  unlock(id: string): Achievement | undefined
}

export interface StatusReportService {
  generate(opts: { file: boolean; includePRs: boolean }): Promise<StatusReport>
}

export interface ToolchainService {
  check(): Promise<ToolStatus[]>
  install(name: string): Promise<OpResult>
  has(name: string): boolean
}

export interface ForgeService {
  available(): boolean
  /** create a PR from branch to base; returns full https URL */
  createPr(cwd: string, opts: { title: string; body: string; base: string; head: string; draft?: boolean }): Promise<{ ok: boolean; url?: string; message: string }>
  view(url: string, cwd?: string): Promise<{
    ok: boolean
    state?: 'OPEN' | 'MERGED' | 'CLOSED'
    isDraft?: boolean
    mergeable?: string
    headSha?: string
    checks: 'pending' | 'passing' | 'failing' | 'none'
    failing: string[]
    pending: string[]
    reviewDecision?: string
    message?: string
  }>
  /** guarded merge: refuses draft/conflicting/red/pending; squash with --match-head-commit; reads back */
  merge(url: string, cwd?: string): Promise<OpResult>
  findPrForBranch(cwd: string, branch: string): Promise<string | undefined>
  myOpenPrs(): Promise<{ url: string; title: string; repo: string; checks: string }[]>
}

export interface AlliesService {
  list(): Ally[]
  create(req: AllyCreateRequest): Promise<Ally>
  retire(name: string): Promise<OpResult>
  /** save an ally's own chat controls; the ally's session picks them up between turns */
  update(name: string, patch: AllyControlsPatch): Ally
  /** route a request from the main wksp to a second unit (marked, correlated) */
  route(name: string, request: string): Promise<OpResult>
  /** a second unit reports to its parent channel (main home wakes) */
  reportToParent(from: string, verb: string, note: string, corr?: string): void
}

export interface MemoryService {
  read(which: MemoryFile, home?: Home): string
  write(which: MemoryFile, content: string, home?: Home): void
  /** budget + decay report used by /save */
  report(home?: Home): { tokens: number; budget: number; overBudget: boolean; stale: string[]; files: { file: string; tokens: number }[] }
  archive(entries: string[], reason: string, home?: Home): void
}

export interface UpdateService {
  check(): Promise<UpdateInfo>
  apply(): Promise<OpResult>
}

/** FAL screen: requests run here with the stored key; the renderer only sees runs. */
export interface FalService {
  runs(): FalRun[]
  /** records the run and starts it in the background (submit → poll → download) */
  run(req: FalRunRequest): FalRun
  cancel(id: string): Promise<OpResult>
  remove(id: string): OpResult
  /** copy an output into a world; refuses to overwrite unless req.overwrite */
  save(req: FalSaveRequest): Promise<FalSaveResult>
  /** session start: keep polling runs that were in flight */
  resume(): void
  /** local file behind a genio-media://fal/<id>/<file> URL */
  mediaPath(id: string, fileName: string): string | undefined
}

export interface PermissionBroker {
  /** ask the player through the GUI; resolves true when allowed */
  ask(req: Omit<PermissionRequest, 'id' | 'ts'>): Promise<boolean>
  resolve(id: string, allow: boolean): void
  pending(): PermissionRequest[]
}

// ---------------------------------------------------------------- per home

export interface CrewService {
  list(): Task[]
  get(id: string): Task | undefined
  update(id: string, patch: Partial<Task>): Task | undefined
  spawn(req: SpawnRequest): Promise<Task>
  /** ping: durable steering inbox write + doorbell; resolveKeys close open choices */
  send(id: string, text: string, resolveKeys?: string[]): Promise<OpResult>
  control(id: string, action: 'interrupt' | 'exit' | 'relaunch', note?: string): Promise<OpResult>
  cleanup(id: string, force?: boolean): Promise<OpResult>
  merge(id: string): Promise<OpResult>
  promote(id: string, intent?: string): Promise<Task>
  /** run the no-mistakes validation pipeline (review → fixes → checks → push → PR → CI) */
  validate(id: string): Promise<OpResult>
  readFile(id: string, which: TaskFile): Promise<string>
  /** one-line current state, companion fm-crew-state style */
  crewState(id: string): Promise<string>
  /** structured fleet view text for the wksp */
  fleetView(): Promise<string>
  playtest(target: { taskId?: string; project?: string }): Promise<TerminalInfo | null>
  /** register a PR url for a task (refuses drafts); arms the merge poll */
  registerPr(id: string, url: string): Promise<OpResult>
  /** append a status line on behalf of Genio (resolved / player-held / note) */
  appendStatus(id: string, line: string): void
  /** parse new status lines since the last read; advances the per-task cursor */
  readNewStatus(id: string): StatusEvent[]
  statusEvents(id: string): StatusEvent[]
  openDecisionKeys(id: string): string[]
  /** session start: mark detached tasks, reconcile worktrees */
  reconcileOnStart(): Promise<void>
  /** number of live (not-yet-PR) tasks holding a capacity place for project */
  capacityUsed(project: string): number
  /** unhandled steering-inbox messages, oldest first */
  unreadInbox(id: string): { seq: number; ageSec: number }[]
  /** type the doorbell line into the unit's terminal again (re-ring) */
  ring(id: string): Promise<boolean>
}

export interface BacklogService {
  list(): BacklogItem[]
  get(id: string): BacklogItem | undefined
  add(item: Partial<BacklogItem> & { title: string }): BacklogItem
  update(id: string, patch: Partial<BacklogItem>): BacklogItem
  remove(id: string): void
  /** player hold (idempotent). until = deferred ("later") */
  hold(id: string, reason: string, until?: string): BacklogItem
  /** record the player's exact words; release=true unholds the work so it proceeds, else closes it */
  answer(id: string, words: string, release: boolean): BacklogItem
  release(id: string): BacklogItem
  /** items whose deps are Done, time gates passed, not held, capacity free */
  dispatchable(): BacklogItem[]
  /** hold bucket per companion: blocked → dated → aged(14d) → live */
  bucket(item: BacklogItem): 'blocked' | 'dated' | 'aged' | 'live' | 'none'
  markInFlight(id: string, taskId: string): void
  markDone(id: string, outcome?: string): void
}

export interface DecisionService {
  list(includeResolved?: boolean): Decision[]
  get(id: string): Decision | undefined
  open(d: Partial<Decision> & { question: string }): Decision
  /** idempotent: one open decision per (taskId,key) */
  openForTask(taskId: string, key: string, question: string, source: Decision['source'], extra?: Partial<Decision>): Decision
  resolve(id: string, answer: string): Decision | undefined
  resolveKey(taskId: string, key: string, answer: string): void
  defer(id: string, until: string): void
}

export interface WakeService {
  enqueue(w: { kind: WakeKind; reason: string; taskId?: string; lines?: string[]; routine?: boolean }): Wake
  pending(): Wake[]
  /** drain: queued events + UNREAD STATUS + OPEN CHOICES + ACK REQUIRED */
  drain(): { text: string; ackThrough: number; count: number }
  ack(throughSeq: number): void
  recent(n: number): Wake[]
}

export interface SupervisorService {
  start(): void
  stop(): void
  /** run one supervision pass now */
  poke(): void
  /** mark that a task's terminal produced output (liveness) */
  touch(taskId: string): void
  /** Claude Stop-hook / turn-end marker observed */
  turnEnded(taskId: string): void
}

export interface WkspService {
  info(): WkspInfo
  history(limit?: number): ChatMessage[]
  /** player message from the GUI (or mail / recap / save synthesized prompts); 'genio' = routed by main Genio to an ally */
  send(text: string, origin?: 'player' | 'system' | 'genio', images?: ChatImageInput[]): Promise<void>
  /** deliver queued wakes (drain → one turn → ack after the turn completes) */
  deliverWakes(): void
  interrupt(): Promise<void>
  restart(fresh: boolean): Promise<void>
  stop(): Promise<void>
  /** append a Genio-authored line to the bridge (no model turn) */
  say(text: string, role?: ChatMessage['role']): ChatMessage
}

export interface HomeCtx {
  home: Home
  crew: CrewService
  backlog: BacklogService
  decisions: DecisionService
  wakes: WakeService
  supervisor: SupervisorService
  wksp: WkspService
}

export interface AppCtx {
  settings: SettingsService
  projects: ProjectsService
  terminals: TerminalService
  away: AwayService
  notifier: NotifierService
  inbox: InboxService
  ledger: LedgerService
  stats: StatsService
  statusReport: StatusReportService
  toolchain: ToolchainService
  forge: ForgeService
  allies: AlliesService
  memory: MemoryService
  update: UpdateService
  permissions: PermissionBroker
  fal: FalService
  main: HomeCtx
  homes: Map<string, HomeCtx>
  home(name: string): HomeCtx
  snapshot(): FleetSnapshot
  /** absolute path of the Genio app source root (for self-update) */
  appRoot: string
}
