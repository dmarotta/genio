import type { InventoryContextReceipt } from './inventory-context'
// Shared data model for Genio main process and renderer.
// Concepts mirror companion (see docs/VOCABULARY.md): the Player talks to one
// companion (Genio) which deploys a Squad of units, each in an isolated git
// worktree, supervised to completion.

import type { ChatImage } from './chat-images'

import type { FalRun } from './api'
import type { UthanaRun } from './uthana'
import type { UsageMode } from './usage-mode'

export type TaskKind = 'ship' | 'scout'

/** How a Build mission lands: no-mistakes=Hardcore (Gauntlet then PR), direct-PR=Standard, local-only=Offline. */
export type DeliveryMode = 'no-mistakes' | 'direct-PR' | 'local-only'
/** Registry posture (Hardcore / Standard / Offline). `no-mistakes-prod-only` resolves per task at intake:
 *  product-facing/mixed/uncertain work -> no-mistakes, internal tooling -> direct-PR. */
export type ProjectMode = DeliveryMode | 'no-mistakes-prod-only'
export type Forge = 'github' | 'gitlab' | 'none'
export type Engine =
  | 'godot' | 'unity' | 'unreal' | 'bevy' | 'web' | 'love2d' | 'gamemaker' | 'defold' | 'monogame' | 'other'

/** strong: ProjectVersion.txt, project.godot, .uproject, .yyp, game.project (found to depth 3);
 *  medium: Bevy Cargo.toml, MonoGame .csproj, web game dependencies (depth 2); weak: main.lua/conf.lua (root only). */
export type EngineStrength = 'strong' | 'medium' | 'weak'

export interface EngineCandidate {
  engine: Engine
  /** Repository-relative POSIX path; '' = the repository root. */
  root: string
  strength: EngineStrength
  version?: string
}

export interface EngineDetection {
  /** Every engine found, in tie-break order (strongest, shallowest, alphabetical); the first one won. */
  candidates: EngineCandidate[]
  /** The top two candidates tie on strength and depth, so the alphabetical order decided. */
  ambiguous: boolean
  /** The winning candidate's engine version, when its project files record one. */
  version?: string
  /** The winner was named by the repository's `.genio/project.json`. */
  declared: boolean
  /** Why a `.genio/project.json` declaration was ignored. */
  warning?: string
  scannedAt: string
}

/**
 * The migration's leftover: the engine and root the player once set by hand, which detection does not pick.
 * Genio never writes it into the repository; the player can ask Genio to pin it in `.genio/project.json`.
 */
export interface EngineProposal {
  engine: Engine
  /** Repository-relative POSIX path, '' = the repository root. */
  engineRoot: string
  /** `.genio/project.json` `{ "engineRoot": engineRoot }` would bring it back: that root holds this engine's marker. */
  declarable: boolean
  notedAt: string
}

export interface ProjectCommands {
  setup?: string
  build?: string
  test?: string
  lint?: string
  /** Retired with Playtest: still detected and kept in stored projects, but nothing runs it. */
  run?: string
}

export interface Project {
  name: string
  path: string
  /** False for ordinary folders; rechecked whenever the project is opened. */
  gitRepo?: boolean
  remote?: string
  defaultBranch: string
  mode: ProjectMode
  /** 'auto' = the mode follows the remote (none/other -> Offline, GitHub -> Standard) and Genio
   *  switches it when the remote changes; 'manual' = the player chose it and it is never auto-changed.
   *  Absent on older entries: see projects.ts modeSourceOf. */
  modeSource?: 'auto' | 'manual'
  yolo: boolean
  branchPrefix: string
  forge: Forge
  /** Max concurrent units for this world. 0/undefined = unbounded. */
  capacity?: number
  engine: Engine
  /** Repository-relative POSIX path; empty string means the repository root. */
  engineRoot?: string
  /** @deprecated Retired: the engine is inferred only. Never written; read once to migrate a manual root. Drop after one release. */
  engineRootSource?: 'auto' | 'manual'
  /** @deprecated Retired: the engine is inferred only. Never written; read once to migrate a manual engine. Drop after one release. */
  engineSource?: 'auto' | 'manual'
  /** What the last engine scan found. Detection alone writes `engine`/`engineRoot` from it. Absent until the first scan. */
  detected?: EngineDetection
  /** A manual engine/root from before the engine was inferred that differs from detection, kept once for the player. */
  engineProposal?: EngineProposal
  commands: ProjectCommands
  description?: string
  /** legacy per-world dial; read as the equivalent Usage mode when usageMode is unset */
  costDial?: CostDial
  /** this world's Usage mode override (Settings → This project → General); unset = the global mode. Cannot raise the global unit cap. */
  usageMode?: UsageMode
  /** on unless false: units may send this world's code to cheap third-party models (OpenRouter via OpenCode); false opts the world out */
  allowCheapModels?: boolean
  /** true when Genio cloned/created it under its home `projects/`. */
  managed: boolean
  addedAt: string
}

export type TaskState =
  | 'spawning'
  | 'working'
  | 'paused'          // declared wait on something external; not Genio action
  | 'blocked'         // needs Genio action
  | 'needs-decision'  // keyed choice open for the player
  | 'validating'      // no-mistakes pipeline running
  | 'ready'           // PR open / local branch ready, waiting on merge authority
  | 'merged'          // landed, awaiting cleanup
  | 'done'            // scout report delivered / finished
  | 'failed'
  | 'exited'          // agent process ended without a terminal status
  | 'stale'           // lagging: no output/status for too long
  | 'detached'        // app restarted; worktree exists, no live process
  | 'cleaned'         // despawned: worktree removed, record kept for history

/** How a finished unit ended, recorded when it finished. */
export type TaskOutcome = 'merged' | 'done' | 'failed' | 'exited abnormally'

export interface PrInfo {
  url: string
  number?: number
  state?: 'OPEN' | 'MERGED' | 'CLOSED'
  checks?: 'pending' | 'passing' | 'failing' | 'none'
  mergeable?: string
  reviewDecision?: string
  checkedAt?: string
}

export interface ValidationStep {
  name: string
  command?: string
  state: 'pending' | 'running' | 'passed' | 'failed' | 'skipped'
  output?: string
  startedAt?: string
  endedAt?: string
}

export interface ValidationRun {
  id: string
  state: 'running' | 'passed' | 'failed' | 'findings' | 'cancelled'
  steps: ValidationStep[]
  findings?: string
  round: number
  startedAt: string
  endedAt?: string
}

export interface Task {
  id: string
  kind: TaskKind
  title: string
  project: string
  /** Base that owns the task: 'main' or an ally name. */
  wksp: string
  backlogId?: string
  mode?: DeliveryMode
  yolo?: boolean
  branchPrefix: string
  baseBranch: string
  branch: string
  worktree: string
  /** Legacy unit artifacts stay at this base so existing briefs and sessions remain valid. */
  storageRoot?: string
  briefPath: string
  reportPath?: string
  harness: string
  model?: string
  effort?: string
  profile?: string
  /** why the unit got this tool / model / effort */
  loadout?: string[]
  /** dispatch category the loadout was picked for */
  category?: TaskCategory
  /** who decided the unit tool, and whether exploration picked it */
  loadoutSource?: Loadout['source']
  ruleId?: string
  explored?: boolean
  /** rework signals for the scorecard */
  counters?: TaskCounters
  /** plan window usage of the unit tool when it deployed (percent) */
  usageAtStart?: number
  /** the player's verdict on how the unit did */
  verdict?: Verdict
  verdictNote?: string
  state: TaskState
  stateReason?: string
  createdAt: string
  updatedAt: string
  lastOutputAt?: string
  lastStatusAt?: string
  terminalId?: string
  pid?: number
  pr?: PrInfo
  validation?: ValidationRun
  promotedFrom?: string
  promotedTo?: string
  inbox: { seq: number; acked: number; lastRingAt?: string; rings: number }
  /** Unread status lines Genio has not processed yet. */
  statusOffset: number
  landedAt?: string
  /** Local fast-forward merges record the landed commit; PR merges keep the PR link. */
  landedCommit?: string
  cleanedAt?: string
  /** When the unit first finished (Squad DONE), kept through a later despawn; cleared on respawn. */
  finishedAt?: string
  /** A finished Recon left with no choice or follow-up was surfaced once as needing the player's call. */
  reconParkedAt?: string
  outcome?: TaskOutcome
  /** Final ready signal, unaffected by later notes or bookkeeping. */
  readyAt?: string
  relaunches: number
  /** Automatic attempts since deliberate resume, completed work, or app restart. */
  automaticRelaunches?: number
  /** Unit-reported session id so a respawn can resume the conversation. */
  sessionHint?: string
  /** Codex session verified against this unit's worktree at relaunch. */
  codexSessionId?: string
  /** The Codex home this unit last ran in (Genio's own, or the player's as a fallback). */
  codexHome?: string
  /** Held by the player's dislike on the Genio message that started it: Genio's own merge and relaunch wait for their answer. */
  dislikePause?: DislikePause
  /** Genio messages the player liked that covered this unit: a positive on the dispatch scorecard. */
  likes?: number
  /** What authorized the merge that landed this Build (also in the ledger's task.merged record). */
  mergeApproval?: MergeApproval
}

/** The authority behind one merge: Auto-loot, the player's verified words, a standing approval, or the Merge button. */
export interface MergeApproval {
  kind: 'autoloot' | 'specific' | 'standing' | 'ui-button'
  at: string
  /** the player's words, quoted from a real player message (or their answer to a merge choice) */
  words?: string
  /** the player chat message that carried them */
  messageId?: string
  messageAt?: string
  /** the standing approval the merge ran under */
  standingId?: string
  /** the merge choice the player answered */
  choiceId?: string
}

/**
 * "Keep merging everything": recorded from a real player message, scoped to one project's Builds,
 * never to destructive actions. Held in memory, so it ends with the session at the latest.
 */
export interface StandingApproval {
  id: string
  project: string
  /** the chat the player said it in */
  wksp: string
  messageId: string
  text: string
  createdAt: string
  expiresAt: string
}

/** What a dislike paused on a unit, so an undo restores exactly that. */
export interface DislikePause {
  /** the disliked chat message and the chat that owns it */
  message: string
  wksp: string
  at: string
  /** the state before the pause; an interrupted unit is relaunched, a ready one keeps its state */
  prevState: TaskState
  interrupted: boolean
}

/** companion status verbs: `<verb> [key=k] [at=epoch]: note` appended to state/<id>.status */
export type StatusKind =
  | 'working' | 'needs-decision' | 'blocked' | 'paused' | 'done' | 'failed' | 'note' | 'resolved' | 'player-held'
  | 'unknown'

export interface StatusEvent {
  taskId: string
  ts: string
  raw: string
  kind: StatusKind
  key?: string
  /** epoch seconds from [at=...]; undefined when missing/malformed (never inferred) */
  at?: number
  text: string
  /** parsed extras: pr=<url>, until=<iso> for paused, branch=... */
  fields: Record<string, string>
  playerRelevant: boolean
}

/** 'held' is legacy input only: stored quests keep the hold as a flag on a queued (or in-flight) quest. */
export type BacklogState = 'queued' | 'in-flight' | 'held' | 'blocked' | 'done' | 'dropped'
export type Priority = 'low' | 'normal' | 'high' | 'critical'

export interface PlayerHold {
  reason: string
  since: string
  until?: string
  /** placed by the player's dislike on this chat message (released when it is undone) */
  reaction?: string
}

/** 'program' is legacy input only: an umbrella becomes a plain tag on its quests. */
export type BacklogKind = TaskKind | 'choice' | 'program'

export interface BacklogItem {
  id: string
  title: string
  project?: string
  kind: BacklogKind
  notes: string
  state: BacklogState
  priority: Priority
  /** manual order within the same priority (lower runs first); unranked quests follow by age */
  rank?: number
  /** id of the quest this one duplicates (same title, created minutes apart or already finished) */
  duplicateOf?: string
  dependsOn: string[]
  notBefore?: string
  hold?: PlayerHold
  /** the player's exact recorded answer, when a held item was answered */
  answer?: string
  /** origin of a player choice, e.g. a recon id whose report raised it */
  origin?: string
  taskId?: string
  mode?: DeliveryMode
  yolo?: boolean
  tags: string[]
  createdAt: string
  updatedAt: string
  doneAt?: string
  outcome?: string
}

export type DecisionSource = 'unit' | 'genio' | 'validation' | 'ally' | 'system'

export interface Decision {
  id: string
  key: string
  wksp: string
  taskId?: string
  backlogId?: string
  project?: string
  question: string
  context?: string
  options: string[]
  recommendation?: string
  /** Explicit related batch, scoped to this base and project. */
  batch?: string
  clarifications?: { question: string; at: string }[]
  /** Persisted content revision for reviewed recommendations. Legacy records start at zero. */
  revision?: number
  source: DecisionSource
  urgency: 'normal' | 'urgent'
  createdAt: string
  resolvedAt?: string
  answer?: string
  /** Deferred until this ISO date (player said "later"). */
  until?: string
  /** what Genio does when the player accepts (the first option) */
  action?: DecisionAction
  /** A player answer given outside the owning chat must reach it: pending until its event is queued there. */
  followUp?: 'pending' | 'delivered'
  /** where the answer came from: a UI click, or a chat answer verified against the player's own message */
  answeredVia?: 'ui' | 'chat'
  /** the player chat message that carried a chat answer */
  answerMessage?: string
}

export type DecisionAction =
  | { kind: 'dispatch-proposal'; proposal: DispatchProposal }
  /** an ambiguous engine detection: the picked option's root is pinned in the repo's .genio/project.json */
  | { kind: 'engine-root'; project: string; roots: Record<string, string> }
  /** what is wrong with a disliked Genio message: "keep going" resumes what the dislike paused */
  | { kind: 'reaction'; wksp: string; message: string }
  /** "Merge now?" for one ready Build: an approving answer is the player's specific approval of that merge */
  | { kind: 'merge-approval'; task: string }

export type WakeKind = 'signal' | 'stale' | 'check' | 'heartbeat' | 'answer' | 'reaction'

export interface Wake {
  seq: number
  ts: string
  wksp: string
  kind: WakeKind
  taskId?: string
  reason: string
  lines: string[]
  /** routine events may be absorbed by the Bot in dnd/afk */
  routine: boolean
  ackedAt?: string
}

export type ChatRole = 'player' | 'genio' | 'system' | 'wake' | 'error'

export interface ToolTrace {
  id: string
  name: string
  input: string
  result?: string
  isError?: boolean
}

export interface ChatMessage {
  provider?: 'claude' | 'codex'
  providerModel?: string
  providerSession?: string
  generation?: import('./generation').GenerationCard
  id: string
  wksp: string
  role: ChatRole
  text: string
  ts: string
  tools?: ToolTrace[]
  /** for streaming: the message is still being written */
  partial?: boolean
  costUsd?: number
  /** images the player attached (stored in the base's data/chat-images) */
  images?: ChatImage[]
  context?: InventoryContextReceipt
  /** in an ally's chat: a request main Genio routed to it (shown as from Genio) */
  from?: 'genio'
  /** a player message not yet read by the session (see ChatQueueState) */
  queue?: ChatQueueState
  /** a Genio image being generated: how many are on the way (the placeholder resolves into images or an error) */
  generating?: number
  /** what this Genio turn started, captured from its tool calls */
  actions?: MessageActions
  /** the player's like or dislike on a Genio message */
  reaction?: MessageReaction
  /** one short line under the message: what a dislike paused or an undo resumed */
  reactionNote?: string
}

/** What one Genio turn started (ids from its tool calls), so a reaction covers exactly that and nothing else. */
export interface MessageActions {
  /** units deployed, relaunched, interrupted, upgraded or sent to the Gauntlet */
  units?: string[]
  /** quests filed, edited, held or released */
  quests?: string[]
  /** units whose work the turn merged */
  merges?: string[]
  /** choices opened */
  choices?: string[]
  /** preferences and project registry entries changed (names only) */
  settings?: string[]
}

export type ReactionKind = 'like' | 'dislike'

export interface MessageReaction {
  kind: ReactionKind
  at: string
  /** dislike: 'grace' during the undo window, then 'paused' (or 'asked' when nothing was paused), 'resumed' after "keep going" */
  pause?: 'grace' | 'paused' | 'asked' | 'resumed'
  /** the choice the dislike opened */
  choice?: string
  /** the reaction log entry that set it (data/reactions.jsonl) */
  event?: string
}

/**
 * 'queued': sent while the session was mid-turn, waiting to be picked up (editable, cancellable).
 * 'unsent': still queued when Genio restarted, so it never reached the session.
 * 'cancelled': only a log tombstone; the message is gone.
 */
export type ChatQueueState = 'queued' | 'unsent' | 'cancelled'

export type WkspActivity = 'offline' | 'starting' | 'idle' | 'thinking' | 'tool' | 'error'

export interface WkspInfo {
  name: string // 'main' or ally name
  displayName: string
  scope?: string
  charter?: string
  model?: string
  effort?: string
  activity: WkspActivity
  activityDetail?: string
  sessionId?: string
  costUsd: number
  turns: number
  queued: number
  limit?: { resetsAt?: number; restartRequired?: boolean; provider?: 'claude' | 'codex'; reason?: string }
  botLimit?: { resetsAt?: number; restartRequired?: boolean; provider?: 'claude' | 'codex'; reason?: string }
  lastError?: string
}

/** An Ally (companion ally): an allied Genio with its own base and charter. */
export interface Ally {
  name: string
  scope: string
  charter: string
  projects: string[]
  model?: string
  effort?: string
  /** this ally chat's approval mode; unset = follow the main chat's chatShellMode */
  shellMode?: Settings['chatShellMode']
  home: string
  createdAt: string
  retiredAt?: string
}

/** player presence: online, dnd (routine events off-screen), afk (the Bot plays) */
export type AwayMode = 'online' | 'dnd' | 'afk'

export interface AwayState {
  mode: AwayMode
  since?: string
  /** escalations captured while away, replayed on return */
  held: AwayEntry[]
  returnSummaryPending: boolean
}

export interface AwayEntry {
  ts: string
  wksp: string
  text: string
  severity: 'info' | 'decision' | 'failure' | 'ready'
  delivered: boolean
  /** world the entry belongs to, for the notification title */
  where?: string
  /** what clicking its notification opens */
  target?: NotifyTarget
}

/** Mail: notes the player sends from elsewhere (companion captain inbox) */
export interface InboxNote {
  id: string
  ts: string
  from: string
  text: string
  ackedAt?: string
  reply?: string
  repliedAt?: string
}

/** Opt-in fleet ledger (companion docs/fleet-ledger.md), at-least-once delivery. */
export interface LedgerRecord {
  v: 1
  ts: string
  home: string
  event:
    | 'task.dispatched' | 'task.status' | 'task.pr_ready' | 'task.merged' | 'task.cleaned_up' | 'task.relaunched'
    | 'decision.opened' | 'decision.resolved' | 'backlog.added' | 'backlog.state'
    | 'project.added' | 'project.removed' | 'project.remote_changed' | 'project.engine_changed' | 'project.pushed' | 'project.push_refused' | 'project.engine_declared'
    | 'presence.changed' | 'achievement' | 'approval.standing' | 'approval.revoked'
  task?: string
  project?: string
  data?: Record<string, unknown>
}

export interface HarnessAdapter {
  id: string
  name: string
  /** executable name or absolute path */
  command: string
  /** argument template; tokens: {model} {effort} {prompt} {session} */
  args: string[]
  modelArgs?: string[]
  effortArgs?: string[]
  /** args used when resuming a previous conversation in the same worktree */
  resumeArgs?: string[]
  /** how the kickoff prompt is delivered */
  promptDelivery: 'arg' | 'type'
  /** extra environment for the unit process */
  env?: Record<string, string>
  /** keystrokes */
  interrupt: string
  exitSequence: string
  /** substrings in terminal output that mean a trust/consent dialog is waiting */
  trustPatterns: string[]
  trustResponse: string
  submitKey: string
  verified: boolean
  role: 'any' | 'worker'
  models: string[]
  builtin: boolean
  enabled: boolean
}

export interface DispatchRule {
  id: string
  /** matched case-insensitively against title+brief; empty = always */
  match: string
  kind?: TaskKind | 'any'
  project?: string
  /** ordered candidates; first available wins unless spendPriority says otherwise */
  candidates: { harness: string; model?: string; effort?: string; spendPriority: number }[]
  /** never reordered or rewritten by the learning loop */
  locked?: boolean
}

/** Fixed dispatch categories (src/shared/dispatch.ts has labels and the default table). */
export type TaskCategory =
  | 'recon-design' | 'feature' | 'bugfix' | 'refactor' | 'graphics' | 'ui' | 'review'
  | 'tests' | 'chore' | 'build-ci' | 'docs' | 'art' | 'large-context'

/** Quality prefers stronger models and more effort, Cost cheaper candidates and less effort. */
export type CostDial = 'quality' | 'balanced' | 'cost'

export type Verdict = 'up' | 'down'

export interface PoolCandidate {
  harness: string
  model?: string
  effort?: string
  /** a cheap third-party model (OpenRouter): only with the key, OpenCode and the world not opted out */
  cheap?: boolean
}

/** One row of the category table: ordered candidates for a category. */
export interface CategoryPool {
  category: TaskCategory
  candidates: PoolCandidate[]
  /** never reordered or rewritten by the learning loop */
  locked?: boolean
}

export interface TaskCounters {
  pings: number
  lagging: number
  stopped: number
  fixRounds: number
}

/** A rule or table change the learning loop proposes; it waits for the player's OK under Your Move. */
export type DispatchProposal =
  | { op: 'pool-add'; category: TaskCategory; candidate: PoolCandidate; evidence: string }
  | { op: 'pool-remove'; category: TaskCategory; candidate: PoolCandidate; evidence: string }
  | { op: 'rule-drop-candidate'; ruleId: string; candidate: PoolCandidate; evidence: string }

/** What the loadout picker needs to know about a mission. Empty harness/model/effort = auto. */
export interface LoadoutInput {
  kind: TaskKind
  project: string
  title: string
  intent: string
  spec?: string
  harness?: string
  model?: string
  effort?: string
  /** passed by Genio at deploy; absent = keyword heuristic */
  category?: TaskCategory
  /** the quest's priority: critical work is never explored */
  priority?: Priority
  /** a follow-up on the same quest keeps this loadout */
  sticky?: { from: string; harness: string; model?: string; effort?: string; category?: TaskCategory }
}

export interface Loadout {
  harness: string
  model?: string
  effort?: string
  /** who decided the unit tool */
  source: 'player' | 'rule' | 'table' | 'mode' | 'default' | 'sticky'
  ruleId?: string
  category: TaskCategory
  /** a less-proven candidate picked on purpose */
  explored?: boolean
  /** one short line per decision */
  reasons: string[]
}

export interface EventSource {
  id: string
  name: string
  command: string
  cwd?: string
  intervalSec: number
  /** wake when: exit code non-zero, or output changes */
  trigger: 'nonzero' | 'change' | 'match'
  pattern?: string
  enabled: boolean
  lastOutput?: string
  lastRunAt?: string
}

export interface Settings {
  /** how Genio addresses the player */
  gamertag: string
  wkspModel: string
  wkspEffort: string
  /** model for the Bot that handles events while the player is DND/AFK */
  botModel: string
  defaultHarness: string
  defaultWorkerModel: string
  defaultWorkerEffort: string
  /** claude unit permission posture: bypass = --dangerously-skip-permissions (companion default) */
  claudePermissionMode: 'bypass' | 'auto' | 'acceptEdits'
  /** Genio chat shell approvals: ask = only read-only commands run unprompted; auto-shell = every Bash/PowerShell command runs; all = YOLO, nothing asks */
  chatShellMode: 'ask' | 'auto-shell' | 'all'
  /** blank = use the Agent SDK's bundled Claude Code */
  claudePath: string
  shell: string
  pollSeconds: number
  /** idle seconds before a non-declared, non-busy unit counts as lagging */
  staleSeconds: number
  staleEscalations: number
  pausedResurfaceHours: number
  heartbeatBaseMinutes: number
  heartbeatMaxMinutes: number
  prPollMinutes: number
  signalGraceSeconds: number
  inboxGraceSeconds: number
  inboxRingMax: number
  /** Legacy stored preference; automatic relaunches now have a hard cap of one. */
  maxRelaunches: number
  /** reviewer model for the Gauntlet (no-mistakes validation pipeline) */
  reviewModel: string
  validationMaxRounds: number
  autoDispatchQueued: boolean
  sound: boolean
  soundVolume: number
  fx: boolean
  /** Clean HUD: hide tool chatter in Comms */
  calm: boolean
  voice: boolean
  desktopNotifications: boolean
  webhookUrl: string
  webhookKind: 'discord' | 'slack' | 'generic'
  /** an AFK escalation unseen longer than this fires the alarm */
  alarmMinutes: number
  /** 'off' | 'auto' (desktop + sound) | 'command:<cmd>' (summary passed as $1/stdin) */
  alarm: string
  /** away digest batching window */
  awayBatchSeconds: number
  inboxServer: boolean
  inboxPort: number
  inboxToken: string
  ledger: boolean
  /** startup memory budget in estimated tokens (companion default 7500) */
  memoryBudgetTokens: number
  /** extra text appended to every unit brief (companion config/brief-include.md) */
  briefInclude: string
  /** strip AI co-author trailers from unit commits */
  stripAiTrailers: boolean
  /** add Genio's own Co-authored-by trailer to unit commits */
  genioCoAuthor: boolean
  /** trailer identity for genioCoAuthor, `Name <email>` */
  genioCoAuthorIdentity: string
  harnesses: HarnessAdapter[]
  dispatchRules: DispatchRule[]
  /** category table: ordered candidates per category, after explicit rules */
  categoryPools: CategoryPool[]
  /** Legacy: read once as the initial usageMode; the mode now sets the dial. */
  costDial: CostDial
  /** Legacy: exploration is set by usageMode (Save 0, Balanced 0, Max 5%). */
  explorationRate: number
  /** Save / Balanced / Max: model, effort, unit cap, exploration, cheap models, wake batching and answer targets */
  usageMode: UsageMode
  /** explicit allowance for paid OpenRouter spend on cheap candidates; a mode never grants it */
  cheapSpendAllowed: boolean
  /** reorder candidates automatically when the scorecard evidence is clear */
  autoReorder: boolean
  eventSources: EventSource[]
  firstRunDone: boolean
}

export interface ToolStatus {
  name: string
  found: boolean
  version?: string
  path?: string
  required: boolean
  purpose: string
  install?: string
}

export interface StatusLine {
  text: string
  taskId?: string
  backlogId?: string
  decisionId?: string
  url?: string
  tone?: 'neon' | 'volt' | 'amber' | 'alert' | 'violet'
}

/** /status (companion /bearings): exactly four sections, always rendered, in this order:
 *  Your Move, Loot, In Progress, Up Next. */
export interface StatusReport {
  generatedAt: string
  yourMove: StatusLine[]
  loot: StatusLine[]
  inProgress: StatusLine[]
  upNext: StatusLine[]
  markdown: string
  filedPath?: string
  includePRs: boolean
}

export interface FleetSnapshot {
  /** Projects of reserved launches not yet represented by a spawning task. */
  pendingUnits?: string[]
  tasks: Task[]
  backlog: BacklogItem[]
  decisions: Decision[]
  projects: Project[]
  wksps: WkspInfo[]
  allies: Ally[]
  away: AwayState
  inbox: InboxNote[]
  stats: FleetStats
  /** active standing merge approvals */
  standing?: StandingApproval[]
}

export interface FleetStats {
  /** builds merged (landed) today and in total; a ready branch or open PR does not count */
  shippedToday: number
  shippedTotal: number
  scoutsTotal: number
  /** SDK estimate: chat, Bot and review only; excludes units and subscription charges. */
  costTodayUsd: number
  level: number
  xp: number
  xpNext: number
  streakDays: number
  achievements: Achievement[]
  playstyle: PlaystyleView
  /** 8 local-calendar weeks, Monday first, oldest first (src/main/landings.ts) */
  landings: LandingDay[]
  /** pinned achievement ids, in pin order (at most three, all unlocked) */
  pins: string[]
}

/** Playstyle families, from the category of recent landed missions (src/shared/playstyle.ts). */
export type PlaystyleId = 'builder' | 'scout' | 'artificer' | 'warden'
export type PlaystyleTitleId = PlaystyleId | 'adventurer'

export interface PlaystyleView {
  /** what the last landed missions say right now */
  current: PlaystyleTitleId
  /** the title on the sheet: the equipped one, else the current one */
  shown: PlaystyleTitleId
  equipped?: PlaystyleId
  /** the evidence behind `current`, with counts */
  why: string
  samples: number
  counts: Record<PlaystyleId, number>
  /** titles ever earned stay available to equip */
  earned: { id: PlaystyleId; at: string }[]
}

export interface LandingDay {
  /** local calendar day, YYYY-MM-DD */
  day: string
  /** merged builds */
  builds: number
  /** recon reports delivered */
  recons: number
  /** unknown: before recording began or Genio recorded nothing that day; future: later this week */
  state: 'recorded' | 'unknown' | 'future'
}

export interface Achievement {
  feature: string
  id: string
  name: string
  description: string
  unlockedAt?: string
  /** Its feature was removed: it never unlocks again, shows only once earned and is left out of totals. */
  retired?: boolean
}

export interface TerminalInfo {
  id: string
  /** Actual PTY root, used only to prove unit process ancestry. */
  pid?: number
  processStartedAt?: number
  processSpawnedAt?: number
  taskId?: string
  title: string
  cwd: string
  alive: boolean
  lastOutputAt?: string
  exitCode?: number
  cols: number
  rows: number
  kind: 'worker' | 'shell' | 'validation'
}

export interface PermissionRequest {
  id: string
  wksp: string
  tool: string
  input: string
  reason?: string
  ts: string
}

export interface UpdateInfo {
  isGitCheckout: boolean
  branch?: string
  behind: number
  ahead: number
  dirty: boolean
  incoming: string[]
  canFastForward: boolean
  error?: string
}

/** Push events main → renderer */
export type GenioEvent =
  | { type: 'pending-units'; projects: string[] }
  | { type: 'inventory'; state: import('./inventory').InventoryState }
  | { type: 'feature-used'; feature: string; id?: string; count?: number }
  | { type: 'snapshot'; data: FleetSnapshot }
  | { type: 'task'; task: Task }
  | { type: 'task-removed'; id: string }
  | { type: 'backlog'; items: BacklogItem[] }
  | { type: 'decisions'; decisions: Decision[] }
  | { type: 'standing-approvals'; approvals: StandingApproval[] }
  | { type: 'projects'; projects: Project[] }
  | { type: 'wksp'; wksp: WkspInfo }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat-delta'; wksp: string; id: string; text: string }
  | { type: 'status'; event: StatusEvent }
  | { type: 'wake'; wake: Wake }
  | { type: 'away'; away: AwayState }
  | { type: 'inbox'; notes: InboxNote[] }
  | { type: 'stats'; stats: FleetStats }
  | { type: 'achievement'; achievement: Achievement }
  | { type: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; title: string; body?: string }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permission-resolved'; id: string }
  | { type: 'terminal'; terminal: TerminalInfo }
  | { type: 'terminal-removed'; id: string }
  | { type: 'model-catalogue-invalidated' }
  | { type: 'settings'; settings: Settings }
  | { type: 'allies'; allies: Ally[] }
  | { type: 'sfx'; sound: SfxName }
  | { type: 'speak'; text: string }
  | { type: 'fal-run'; run: FalRun }
  | { type: 'navigate'; target: NotifyTarget }
  | { type: 'fal-catalogue' }
  | { type: 'uthana-run'; run: UthanaRun }
  /** A chat generation (card or generate_image placeholder) started or settled; drives the panel's generating count. */
  | { type: 'generation'; wksp: string; id: string; active: boolean }

/** Notification destination; legacy `move` targets reveal pending answer cards. */
export type NotifyTarget = { view: 'move'; project?: string; wksp?: string; decisionId?: string } | { view: 'squad'; taskId?: string } | { view: 'comms'; wksp?: string } | { view: 'accounts' }

export type SfxName = 'blip' | 'spawn' | 'ready' | 'merge' | 'alert' | 'decision' | 'levelup' | 'send' | 'error' | 'card-in' | 'card-out'
