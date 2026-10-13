import { ThisProjectSettings } from './ProjectSettings'
import { ModelPicker, useModelCatalogue } from '../components/ModelPicker'
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Copy, Download, KeyRound, Lock, LockOpen, LogIn, LogOut, Plus, RefreshCw, Trash, TriangleAlert, Users, Wrench, X } from 'lucide-react'
import type { CategoryPool, DispatchRule, EventSource, HarnessAdapter, PoolCandidate, Settings, ToolStatus, UpdateInfo } from '@shared/types'
import {
  CATEGORIES, LEARNING, QUOTA_HOT_PERCENT, categoryLabel, defaultCategoryPools, type DispatchScoresView, type ScoreRow
} from '@shared/dispatch'
import {
  MODE_PRESETS, USAGE_MODES, USAGE_MODE_LABEL, modeSummary, pctText, planLabel, presetRows, type UsageMode, type UsagePolicyView
} from '@shared/usage-mode'
import { PlanMeter, useUsagePolicyState } from '../components/PlanMeter'
import { accountActions, type AccountStatus, type ApiKeyStatus, type ExplorerStatus, type FalSpend, type ToolUsage, type UsageReport } from '@shared/api'
import { api, errText, op, saveSettings, toast, useStore } from '../store'
import { CommitInput, Confirm, Field, Toggle, ViewHeader } from '../components/ui'
import { TerminalView } from '../components/Terminal'
import { Memory } from '../components/Memory'
import { Mailbox } from '../components/Mailbox'
import { EFFORTS } from '../lib/vocab'
import { ago, clock, cx, dateShort, usd } from '../lib/format'
import { playSfx } from '../lib/sfx'

export type Section =
  | 'project' | 'profile' | 'genio' | 'units' | 'overwatch' | 'gauntlet' | 'comms' | 'alerts' | 'mail' | 'memory'
  | 'harnesses' | 'dispatch' | 'triggers' | 'toolchain' | 'accounts' | 'patch' | 'usage' | 'explorer'

export const SECTIONS: { id: Section; label: string; group: string }[] = [
  { id: 'project', label: 'This project', group: 'Project' },
  { id: 'profile', label: 'Profile', group: 'Player' },
  { id: 'memory', label: 'Memory', group: 'Player' },
  { id: 'mail', label: 'Mail & replay', group: 'Player' },
  { id: 'comms', label: 'Comms & FX', group: 'Player' },
  { id: 'alerts', label: 'Alerts', group: 'Player' },
  { id: 'usage', label: 'Usage', group: 'Squad' },
  { id: 'genio', label: 'Genio', group: 'Squad' },
  { id: 'units', label: 'Units', group: 'Squad' },
  { id: 'harnesses', label: 'Harnesses', group: 'Squad' },
  { id: 'dispatch', label: 'Dispatch (Advanced)', group: 'Squad' },
  { id: 'overwatch', label: 'Overwatch', group: 'Engine' },
  { id: 'gauntlet', label: 'Gauntlet', group: 'Engine' },
  { id: 'triggers', label: 'Triggers', group: 'Engine' },
  { id: 'toolchain', label: 'Loadout', group: 'Base' },
  { id: 'explorer', label: 'Explorer', group: 'Base' },
  { id: 'accounts', label: 'Accounts', group: 'Base' },
  { id: 'patch', label: 'Patch', group: 'Base' }
]

let pendingSection: Section | null = null
const sectionListeners = new Set<(section: Section) => void>()
export function requestSystemsSection(s: Section): void {
  pendingSection = sectionListeners.size ? null : s
  for (const listener of sectionListeners) listener(s)
}

export function Systems() {
  const settings = useStore((s) => s.settings)
  const unread = useStore((s) => s.snap.inbox.filter((n) => !n.ackedAt).length)
  const [sec, setSec] = useState<Section>(() => {
    const p = pendingSection
    pendingSection = null
    return p ?? 'profile'
  })
  useEffect(() => {
    sectionListeners.add(setSec)
    return () => { sectionListeners.delete(setSec) }
  }, [])
  const [home, setHome] = useState('')
  const [advanced, setAdvancedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('genio.usage.advanced') === '1'
    } catch {
      return false
    }
  })
  const setAdvanced = (v: boolean): void => {
    setAdvancedState(v)
    try {
      localStorage.setItem('genio.usage.advanced', v ? '1' : '0')
    } catch {
      /* per-viewer convenience only */
    }
  }
  useEffect(() => {
    void api().homePath().then(setHome).catch(() => undefined)
  }, [])
  if (!settings) return <div className="view"><div className="bar indeterminate"><i /></div></div>

  // Dispatch tables, rules and telemetry are Advanced: listed only while Advanced is open
  const visible = SECTIONS.filter((x) => x.id !== 'dispatch' || advanced || sec === 'dispatch')
  let lastGroup = ''
  return (
    <div className="view">
      <ViewHeader
        kicker={home ? `Base · ${home}` : 'Configuration'}
        title={
          <>
            <span className="accent">Settings</span>
          </>
        }
      />
      <div className="sys-layout">
        <nav className="sys-nav">
          {visible.map((s) => {
            const head = s.group !== lastGroup
            lastGroup = s.group
            return (
              <div key={s.id}>
                {head && <div className="label sys-group">{s.group}</div>}
                <button className={cx('sys-link', sec === s.id && 'on')} onClick={() => setSec(s.id)}>
                  {s.label}
                  {s.id === 'mail' && unread > 0 && <span className="sys-badge">{unread}</span>}
                </button>
              </div>
            )
          })}
        </nav>
        <div className="sys-body panel">
          <SectionBody sec={sec} s={settings} advanced={advanced} setAdvanced={setAdvanced} open={setSec} />
        </div>
      </div>
    </div>
  )
}

function ExplorerIntegration() {
  const [state, setState] = useState<ExplorerStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api().explorerStatus().then(value => { if (active) setState(value) }).catch(e => { if (active) setError(errText(e)) })
    return () => { active = false }
  }, [])
  const change = async (enabled: boolean): Promise<void> => {
    setBusy(true); setError('')
    try { setState(await api().explorerSet(enabled)) }
    catch (e) {
      setError(errText(e))
      // A failed install may have left one key; keep Remove available.
      try { setState(await api().explorerStatus()) } catch { /* retain last state */ }
    } finally { setBusy(false) }
  }
  return <>
    <h2 className="sys-title">Explorer</h2>
    <Row label="Open with Genio" hint="Open or focus a project from a folder or folder background. Installs for your Windows account only; no administrator rights required.">
      <button className="btn sm" disabled={busy || state?.available === false || state?.installed === true} onClick={() => void change(true)}>Install</button>
      <button className="btn sm" disabled={busy || state?.available === false} onClick={() => void change(false)}>Remove</button>
    </Row>
    <p className="mute">{busy ? 'Updating Explorer…' : state?.available === false ? 'Available on Windows only.' : state?.installed ? 'Installed for this Genio location.' : state?.present ? 'A partial or older installation exists. Install to update it, or Remove to clean it up.' : 'Not installed.'}</p>
    {error && <p role="alert">{error}</p>}
    <p className="dim">On Windows 11, use Show more options in the context menu. Moving Genio requires installing again from its new location.</p>
    <Row label="Terminal command" hint="Add the Genio resources folder to your user PATH to use the genio.cmd shim. See README → Open a project folder.">
      <code>genio .</code>
    </Row>
  </>
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="sys-row">
      <div className="sys-row-label">
        <div className="sys-row-title">{label}</div>
        {hint && <div className="mute sys-row-hint">{hint}</div>}
      </div>
      <div className="sys-row-ctl">{children}</div>
    </div>
  )
}

const set = (patch: Partial<Settings>): void => void saveSettings(patch)
const num = (v: string, min = 0): number => Math.max(min, Number(v) || 0)

function SectionBody({ sec, s, advanced, setAdvanced, open }: { sec: Section; s: Settings; advanced: boolean; setAdvanced: (v: boolean) => void; open: (s: Section) => void }) {
  switch (sec) {
    case 'project':
      return <ThisProjectSettings />
    case 'explorer':
      return <ExplorerIntegration />
    case 'usage':
      return <Usage s={s} advanced={advanced} setAdvanced={setAdvanced} open={open} />
    case 'profile':
      return (
        <>
          <h2 className="sys-title">Profile</h2>
          <Row label="Gamertag" hint="How Genio addresses you.">
            <CommitInput value={s.gamertag} onCommit={(v) => set({ gamertag: v.trim() || 'Player' })} />
          </Row>
          <Row label="Replay onboarding" hint="Show the first-run setup again.">
            <button className="btn sm" onClick={() => set({ firstRunDone: false })}>
              Replay
            </button>
          </Row>
        </>
      )
    case 'comms':
      return (
        <>
          <h2 className="sys-title">Comms & FX</h2>
          <Row label="Sound effects" hint="Synthesized blips for deploys, merges, choices.">
            <Toggle checked={s.sound} onChange={(v) => set({ sound: v })} />
          </Row>
          <Row label="Volume">
            <input
              type="range"
              className="range"
              min={0}
              max={1}
              step={0.05}
              value={s.soundVolume}
              onChange={(e) => set({ soundVolume: Number(e.target.value) })}
              onMouseUp={() => playSfx('ready', { ...s, sound: true })}
            />
          </Row>
          <Row label="Visual FX" hint="Scanlines and the tactical grid.">
            <Toggle
              checked={s.fx}
              onChange={(v) => {
                document.body.classList.toggle('fx-off', !v)
                set({ fx: v })
              }}
            />
          </Row>
          <Row label="Clean HUD" hint="Hide tool chatter and routine events in Comms.">
            <Toggle checked={s.calm} onChange={(v) => set({ calm: v })} />
          </Row>
          <Row label="Voice" hint="Genio reads its replies aloud.">
            <Toggle checked={s.voice} onChange={(v) => set({ voice: v })} />
          </Row>
          <Row label="Desktop notifications" hint="Ready Builds, choices and failures when Genio is in the background.">
            <Toggle checked={s.desktopNotifications} onChange={(v) => set({ desktopNotifications: v })} />
          </Row>
        </>
      )
    case 'alerts':
      return (
        <>
          <h2 className="sys-title">Alerts</h2>
          <p className="mute">While you're DND or AFK, outcomes that need you are pushed here too.</p>
          <Row label="Webhook kind">
            <select className="select" value={s.webhookKind} onChange={(e) => set({ webhookKind: e.target.value as Settings['webhookKind'] })}>
              <option value="discord">Discord</option>
              <option value="slack">Slack</option>
              <option value="generic">Generic JSON</option>
            </select>
          </Row>
          <Row label="Webhook URL" hint="Leave blank to disable.">
            <CommitInput mono value={s.webhookUrl} placeholder="https://discord.com/api/webhooks/…" onCommit={(v) => set({ webhookUrl: v.trim() })} />
          </Row>
          <Row label="Alarm" hint={<>off · auto (desktop + sound) · <span className="mono">command:&lt;cmd&gt;</span> (summary as $1 and stdin)</>}>
            <CommitInput mono value={s.alarm} onCommit={(v) => set({ alarm: v.trim() || 'auto' })} />
          </Row>
          <Row label="Alarm after (min)" hint="An AFK escalation unseen this long re-alerts.">
            <CommitInput type="number" value={s.alarmMinutes} onCommit={(v) => set({ alarmMinutes: num(v, 1) })} />
          </Row>
          <Row label="AFK digest window (s)" hint="Batch escalations before pushing.">
            <CommitInput type="number" value={s.awayBatchSeconds} onCommit={(v) => set({ awayBatchSeconds: num(v) })} />
          </Row>
        </>
      )
    case 'genio':
      return (
        <>
          <h2 className="sys-title">Genio</h2>
          <Row label="Model and effort" hint="Set by the Usage mode. Raw chat picks are under Usage → Advanced.">
            <button className="btn sm" onClick={() => open('usage')}>Usage</button>
          </Row>
          <Row label="Claude Code path" hint="Blank uses the bundled Claude Code.">
            <CommitInput mono value={s.claudePath} placeholder="(bundled)" onCommit={(v) => set({ claudePath: v.trim() })} />
          </Row>
          <Row label="Auto-dispatch queued quests" hint="Genio deploys queued quests as soon as deps, gates and capacity clear.">
            <Toggle checked={s.autoDispatchQueued} onChange={(v) => set({ autoDispatchQueued: v })} />
          </Row>
        </>
      )
    case 'units':
      return (
        <>
          <h2 className="sys-title">Units</h2>
          <Row label="Default harness">
            <select className="select" value={s.defaultHarness} onChange={(e) => set({ defaultHarness: e.target.value })}>
              {s.harnesses
                .filter((h) => h.enabled)
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
            </select>
          </Row>
          <Row
            label="Claude permission posture"
            hint={
              s.claudePermissionMode === 'bypass' ? (
                <span className="amber-text">
                  <TriangleAlert size={12} style={{ verticalAlign: -2 }} /> Bypass lets Claude units run any command without asking, inside their isolated copy. Fast, autonomous, and trusting.
                </span>
              ) : (
                'Units may stop to ask for permission in their terminal.'
              )
            }
          >
            <select className="select" value={s.claudePermissionMode} onChange={(e) => set({ claudePermissionMode: e.target.value as Settings['claudePermissionMode'] })}>
              <option value="bypass">Bypass (autonomous)</option>
              <option value="auto">Auto (classifier)</option>
              <option value="acceptEdits">Accept edits only</option>
            </select>
          </Row>
          <Row label="Shell" hint="For Shell sessions and playtests.">
            <CommitInput mono value={s.shell} onCommit={(v) => set({ shell: v.trim() })} />
          </Row>
          <Row label="Automatic respawns" hint="One attempt, then the unit waits for a manual Respawn from Squad.">
            <span className="mono">1</span>
          </Row>
          <Row label="Strip AI commit trailers">
            <Toggle checked={s.stripAiTrailers} onChange={(v) => set({ stripAiTrailers: v })} />
          </Row>
          <Row label="Co-authored by Genio" hint="Adds a Co-authored-by trailer for Genio to every unit commit.">
            <Toggle checked={s.genioCoAuthor} onChange={(v) => set({ genioCoAuthor: v })} />
          </Row>
          <Row label="Genio trailer identity" hint="Name <email>. The .invalid domain never links to a real account.">
            <CommitInput mono value={s.genioCoAuthorIdentity} onCommit={(v) => set({ genioCoAuthorIdentity: v.trim() })} />
          </Row>
          <div className="sys-row col">
            <div className="sys-row-title">Brief additions</div>
            <div className="mute sys-row-hint">Appended to every unit brief.</div>
            <BriefInclude value={s.briefInclude} />
          </div>
        </>
      )
    case 'overwatch':
      return (
        <>
          <h2 className="sys-title">Overwatch</h2>
          <p className="mute">Zero-token supervision timings. Genio only wakes when something is actionable.</p>
          <NumRow label="Poll every (s)" value={s.pollSeconds} onCommit={(v) => set({ pollSeconds: num(v, 3) })} />
          <NumRow label="Lagging after (s)" hint="Idle with no declared wait." value={s.staleSeconds} onCommit={(v) => set({ staleSeconds: num(v, 30) })} />
          <NumRow label="Lag escalations" hint="Before deep inspection." value={s.staleEscalations} onCommit={(v) => set({ staleEscalations: num(v, 1) })} />
          <NumRow label="Paused resurface (h)" value={s.pausedResurfaceHours} onCommit={(v) => set({ pausedResurfaceHours: num(v, 1) })} />
          <Row label="Heartbeat" hint="Routine heartbeat and wake batching follow the Usage mode.">
            <span className="mono">{MODE_PRESETS[s.usageMode ?? 'balanced'].heartbeat.baseMinutes}/{MODE_PRESETS[s.usageMode ?? 'balanced'].heartbeat.maxMinutes} min</span>
          </Row>
          <NumRow label="PR poll (min)" value={s.prPollMinutes} onCommit={(v) => set({ prPollMinutes: num(v, 1) })} />
          <NumRow label="Ping re-ring (s)" value={s.inboxGraceSeconds} onCommit={(v) => set({ inboxGraceSeconds: num(v, 10) })} />
          <NumRow label="Ping rings before escalating" value={s.inboxRingMax} onCommit={(v) => set({ inboxRingMax: num(v, 1) })} />
        </>
      )
    case 'gauntlet':
      return (
        <>
          <h2 className="sys-title">Gauntlet</h2>
          <p className="mute">Hardcore validation: checks, AI review against your words, fix rounds, push, PR, CI.</p>
          <ModelRow allowCustom label="Reviewer model" value={s.reviewModel} onCommit={(v) => set({ reviewModel: v })} />
          <NumRow label="Max fix rounds" value={s.validationMaxRounds} onCommit={(v) => set({ validationMaxRounds: num(v, 1) })} />
        </>
      )
    case 'memory':
      return (
        <>
          <Memory budget={s.memoryBudgetTokens} />
          <NumRow label="Memory budget (tokens)" hint="Player profile + squad memory kept under this on /save." value={s.memoryBudgetTokens} onCommit={(v) => set({ memoryBudgetTokens: num(v, 500) })} />
        </>
      )
    case 'mail':
      return <MailServer s={s} />
    case 'harnesses':
      return <Harnesses s={s} />
    case 'dispatch':
      return <Dispatch s={s} />
    case 'triggers':
      return <Triggers s={s} />
    case 'toolchain':
      return <Toolchain />
    case 'accounts':
      return <Accounts />
    case 'patch':
      return <Patch />
  }
}

const LEVEL_TEXT = { ok: 'below 70%: the mode as set', warm: '70-84%: exploration off, one unit, Auto effort one step lower, other plan preferred', hot: '85-94%: no automatic units; Auto chat Sonnet / low', out: '95%+ or rejected: no new automatic work until reset' } as const

/** Systems → Usage: one mode, what it sets, what is pinned, protection and the shared plan meter. */
function Usage({ s, advanced, setAdvanced, open }: { s: Settings; advanced: boolean; setAdvanced: (v: boolean) => void; open: (s: Section) => void }) {
  const { view, error: usageError } = useUsagePolicyState()
  const mode: UsageMode = s.usageMode ?? 'balanced'
  const [hover, setHover] = useState<UsageMode | null>(null)
  const shown = hover ?? mode
  const pins = pinnedOverrides(s, view)
  return (
    <>
      <h2 className="sys-title">Usage</h2>
      <div className="usage-mode-bar">
        <span className="label">Usage mode</span>
        <div className="seg" role="radiogroup" aria-label="Usage mode">
          {USAGE_MODES.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={cx('btn sm', mode === m && 'solid')}
              onMouseEnter={() => setHover(m)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(m)}
              onBlur={() => setHover(null)}
              onClick={() => set({ usageMode: m })}
            >
              {USAGE_MODE_LABEL[m]}
              {m === 'balanced' ? '*' : ''}
            </button>
          ))}
        </div>
        <button className={cx('btn sm ghost', advanced && 'neon')} aria-pressed={advanced} onClick={() => setAdvanced(!advanced)}>
          Advanced
        </button>
      </div>
      <div className="usage-summary">
        <b>{modeSummary(mode, view?.chat)}</b>
        {view && <span className="mute"> · {view.liveUnits} of {view.unitCap} unit places in use across all projects</span>}
        <div className="mute">Save allows up to {MODE_PRESETS.save.unitCap} concurrent units, Balanced {MODE_PRESETS.balanced.unitCap}, Max {MODE_PRESETS.max.unitCap}, shared across all projects. * Balanced is the default. Max means higher ceilings, never permission to exhaust a plan.</div>
      </div>

      <div className="usage-preview panel">
        <div className="label">{hover && hover !== mode ? `Preview: what ${USAGE_MODE_LABEL[shown]} would set` : `What ${USAGE_MODE_LABEL[shown]} sets`}</div>
        <div className="usage-preview-grid">
          {presetRows(shown).map((r) => (
            <Fragment key={r.label}>
              <span className="mute">{r.label}</span>
              <span className="mono">{r.value}</span>
            </Fragment>
          ))}
        </div>
        <div className="mute usage-preview-foot">Pinned choices below are kept as they are. Bot: Sonnet / low only when deterministic handling cannot finish. Polling, PR checks and permissions are not changed by a mode.</div>
      </div>

      <div className="label" style={{ margin: '18px 0 6px' }}>Pinned</div>
      {pins.length === 0 ? (
        <div className="mute">Nothing pinned: every model and effort follows the mode.</div>
      ) : (
        <div className="usage-pins">
          {pins.map((p) => (
            <div key={p.label} className="usage-pin">
              <span className="chip amber">Pinned</span>
              <span>{p.label}</span>
              <span className="mono">{p.value}</span>
              {p.unpin ? (
                <button className="btn sm ghost" onClick={p.unpin}>Unpin</button>
              ) : (
                <button className="btn sm ghost" onClick={() => { setAdvanced(true); open('dispatch') }}>Open</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="label" style={{ margin: '18px 0 6px' }}>Automatic protection</div>
      <p className="mute">Applies to automatic choices in every mode, using the worst reported window of each plan. Pinned choices, permissions, queued work and paid spend are never changed.</p>
      {view && (
        <div className="usage-levels">
          {view.plans.map((p) => (
            <div key={p.plan} className={cx('usage-level', `lvl-${p.level}`)}>
              <b>{planLabel(p.plan)}</b>
              <span className="mono">{p.known || p.level !== 'ok' ? pctText(p) : 'unknown'}</span>
              <span className="mute">{p.known || p.level !== 'ok' ? LEVEL_TEXT[p.level] : 'no current report: ordinary dispatch, never exploration'}</span>
            </div>
          ))}
        </div>
      )}
      {view && view.waiting.length > 0 && (
        <div className="amber-text" style={{ marginTop: 8 }}>
          {view.waiting.length} queued quest{view.waiting.length === 1 ? '' : 's'} wait{view.waiting.length === 1 ? 's' : ''} for a plan reset (see Quests).
        </div>
      )}
      {view && view.notices.length > 0 && (
        <>
          <div className="label" style={{ margin: '14px 0 6px' }}>Recent notices</div>
          <div className="usage-notices">
            {view.notices.map((n) => (
              <details key={`${n.ts}-${n.plan}`}>
                <summary>
                  <span className="mono mute">{dateShort(n.ts)} {clock(n.ts)}</span> {n.text}
                </summary>
                <div className="mute mono">{n.details}</div>
              </details>
            ))}
          </div>
        </>
      )}

      <div className="label" style={{ margin: '18px 0 6px' }}>Plan remaining</div>
      <PlanMeter view={view} error={usageError} />

      {advanced && <UsageAdvanced s={s} view={view} open={open} />}
    </>
  )
}

interface Pin {
  label: string
  value: string
  unpin?: () => void
}

function pinnedOverrides(s: Settings, view: UsagePolicyView | null): Pin[] {
  const out: Pin[] = []
  if (s.wkspModel) out.push({ label: 'Chat model', value: s.wkspModel, unpin: () => set({ wkspModel: '' }) })
  if (s.wkspEffort) out.push({ label: 'Chat effort', value: s.wkspEffort, unpin: () => set({ wkspEffort: '' }) })
  if (s.defaultWorkerModel) out.push({ label: `Unit model (${s.defaultHarness})`, value: s.defaultWorkerModel, unpin: () => set({ defaultWorkerModel: '' }) })
  if (s.defaultWorkerEffort) out.push({ label: 'Unit effort', value: s.defaultWorkerEffort, unpin: () => set({ defaultWorkerEffort: '' }) })
  const locked = s.categoryPools.filter((p) => p.locked)
  if (locked.length) out.push({ label: 'Category rows', value: locked.map((p) => categoryLabel(p.category)).join(', ') })
  if (s.dispatchRules.length) out.push({ label: 'Dispatch rules', value: `${s.dispatchRules.length} rule${s.dispatchRules.length === 1 ? '' : 's'}` })
  for (const w of view?.worlds ?? []) {
    if (w.source === 'global') continue
    out.push({
      label: `Project ${w.name}`,
      value: `${USAGE_MODE_LABEL[w.mode]}${w.source === 'legacy-dial' ? ' (from its old cost dial)' : ''}`,
      unpin: () => void op('Project usage mode', () => api().projectUpdate(w.name, { usageMode: undefined, costDial: undefined }))
    })
  }
  return out
}

/** Advanced: raw chat/unit/Bot picks (each one Pins), per-world mode and capacity, paid-spend allowance, tables. */
function UsageAdvanced({ s, view, open }: { s: Settings; view: UsagePolicyView | null; open: (s: Section) => void }) {
  const projects = useStore((st) => st.snap.projects)
  return (
    <div className="usage-advanced">
      <h3 className="sys-subtitle">Advanced</h3>
      <p className="mute">Any value set here is Pinned: the mode and protection leave it alone. Blank or (auto) follows the mode.</p>
      <ModelRow label="Chat model" hint="Default for project chats without their own pick." value={s.wkspModel} onCommit={(v) => set({ wkspModel: v })} />
      <Row label="Chat effort">
        <EffortSelect model={s.wkspModel} value={s.wkspEffort} onChange={(v) => set({ wkspEffort: v })} />
      </Row>
      <Row label="Bot model" hint="Handles events while you're DND/AFK using the main chat selection.">
        <span className="mute">Inherits the main chat provider and model; read-only tools.</span>
      </Row>
      <ModelRow allowCustom label="Unit model" hint={`Applies to ${s.defaultHarness} units.`} value={s.defaultWorkerModel} onCommit={(v) => set({ defaultWorkerModel: v })} />
      <Row label="Unit effort" hint="Blank: the mode's effort per category.">
        <EffortSelect value={s.defaultWorkerEffort} onChange={(v) => set({ defaultWorkerEffort: v })} />
      </Row>
      <Row label="Paid spend on cheap models" hint="Lets low-stakes units use OpenRouter models through OpenCode, billed to your OpenRouter key. A mode never turns this on.">
        <Toggle checked={!!s.cheapSpendAllowed} onChange={(v) => set({ cheapSpendAllowed: v })} />
        {view && <span className="mute">{view.cheap.why}</span>}
      </Row>
      <div className="label" style={{ margin: '16px 0 6px' }}>Projects</div>
      <p className="mute">A project can use its own mode. Its unit cap can only be lower than the global {MODE_PRESETS[s.usageMode ?? 'balanced'].unitCap}.</p>
      {projects.map((p) => {
        const w = view?.worlds.find((x) => x.name === p.name)
        return (
          <Row key={p.name} label={p.name} hint={w?.cap !== undefined ? `at most ${w.cap} unit${w.cap === 1 ? '' : 's'} here` : undefined}>
            <select
              className="select"
              value={p.usageMode ?? ''}
              onChange={(e) => void op('Project usage mode', () => api().projectUpdate(p.name, { usageMode: (e.target.value || undefined) as UsageMode | undefined, costDial: undefined }))}
            >
              <option value="">Global ({USAGE_MODE_LABEL[s.usageMode ?? 'balanced']})</option>
              {USAGE_MODES.map((m) => <option key={m} value={m}>{USAGE_MODE_LABEL[m]}</option>)}
            </select>
            <span className="mute">capacity</span>
            <CommitInput type="number" className="num-input" value={p.capacity ?? 0} onCommit={(v) => void op('Project capacity', () => api().projectUpdate(p.name, { capacity: Math.max(0, parseInt(v, 10) || 0) }))} />
          </Row>
        )
      })}
      <Row label="Category table, rules, scorecard" hint="Locked rows and rules are Pinned; unlocked rows follow the mode.">
        <button className="btn sm" onClick={() => open('dispatch')}>Dispatch</button>
      </Row>
    </div>
  )
}

/** Measured tokens per world, separate from the shared plan meter (a world has no private quota). */
function WorldAttribution({ usage }: { usage: UsageReport }) {
  const rows = usage.tools.flatMap((t) => Object.entries(t.measured?.byWorld ?? {}).map(([world, v]) => ({ tool: t.tool, world, ...v })))
  if (!rows.length) return null
  return (
    <div className="usage-block" style={{ margin: '10px 0 16px' }}>
      <div className="usage-head">
        <b>Attributed to projects</b>
        <span className="mute">project chat and unit tokens measured from local logs · shared account plans · legacy shared chat remains unattributed</span>
      </div>
      <div className="usage-tokens mono">
        <span className="mute">project</span>
        <span className="mute">plan</span>
        <span className="mute">today</span>
        <span className="mute">7 days</span>
        <span />
        <span />
        {rows.map((r) => (
          <Fragment key={`${r.tool}:${r.world}`}>
            <span>{r.world}</span>
            <span>{planLabel(r.tool)}</span>
            <span>{tokens(r.today.total)}</span>
            <span>{tokens(r.week.total)}</span>
            <span />
            <span />
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function NumRow({ label, hint, value, onCommit }: { label: string; hint?: string; value: number; onCommit: (v: string) => void }) {
  return (
    <Row label={label} hint={hint}>
      <CommitInput type="number" value={value} onCommit={onCommit} className="num-input" />
    </Row>
  )
}

function ModelRow({ label, hint, value, onCommit, allowCustom }: { label: string; hint?: string; value: string; onCommit: (v: string) => void; allowCustom?: boolean }) {
  return <Row label={label} hint={hint}>{allowCustom && <CommitInput mono value={value} placeholder="(default)" onCommit={v => onCommit(v.trim())} />}<ModelSelect value={value} onChange={onCommit} /></Row>
}

type SelectProps = { value: string; onChange: (v: string) => void; title?: string; disabled?: boolean; style?: CSSProperties }
export function ModelSelect(props: SelectProps) {
  return <ModelPicker {...props} onAccounts={() => requestSystemsSection('accounts')} />
}

export function EffortSelect({ value, onChange, model, ...rest }: SelectProps & { model?: string }) {
  const catalogue = useModelCatalogue()
  const selected = catalogue.routes.flatMap(r => r.models).find(m => (m.key === model || m.runtime === 'claude' && (m.id === model || m.aliases.includes(model || 'default'))))
  const efforts = (model === undefined ? EFFORTS : selected?.efforts || []).filter(e => e !== 'ultra')
  return (
    <select className="select" value={efforts.includes(value) ? value : ""} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="">(auto)</option>
      {efforts.map((x) => (
        <option key={x} value={x}>
          {x}
        </option>
      ))}
    </select>
  )
}

function BriefInclude({ value }: { value: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <>
      <textarea className="textarea mono" rows={8} value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. Always run the GUT test suite before declaring done." />
      <div>
        <button className="btn sm solid" disabled={v === value} onClick={() => set({ briefInclude: v })}>
          Save
        </button>
      </div>
    </>
  )
}

function MailServer({ s }: { s: Settings }) {
  return (
    <>
      <h2 className="sys-title">Mail & replay</h2>
      <Mailbox />
      <Row label="Mail HTTP intake" hint="Send Genio notes from your phone or scripts. Localhost only, token protected.">
        <Toggle checked={s.inboxServer} onChange={(v) => set({ inboxServer: v })} />
      </Row>
      <Row label="Port">
        <CommitInput type="number" value={s.inboxPort} onCommit={(v) => set({ inboxPort: num(v, 1024) })} />
      </Row>
      <Row label="Token">
        <div className="row">
          <input className="input mono" readOnly value={s.inboxToken ? s.inboxToken.replace(/.(?=.{4})/g, '•') : '(generated on enable)'} />
          <button
            className="btn icon"
            disabled={!s.inboxToken}
            title="Copy token"
            onClick={() => {
              void navigator.clipboard.writeText(s.inboxToken).then(() => toast('success', 'Token copied'))
            }}
          >
            <Copy size={14} />
          </button>
        </div>
      </Row>
      {s.inboxServer && s.inboxToken && (
        <pre className="file-pre selectable" style={{ marginTop: 8 }}>
          {`curl -X POST http://127.0.0.1:${s.inboxPort}/inbox \\\n  -H "Authorization: Bearer <token>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text":"add a pause menu","from":"phone"}'`}
        </pre>
      )}
      <Row label="Replay log" hint="Append-only activity ledger other tools can read (fleet-ledger.jsonl).">
        <Toggle checked={s.ledger} onChange={(v) => set({ ledger: v })} />
      </Row>
    </>
  )
}

function Harnesses({ s }: { s: Settings }) {
  const save = (list: HarnessAdapter[]): void => set({ harnesses: list })
  const upd = (id: string, patch: Partial<HarnessAdapter>): void => save(s.harnesses.map((h) => (h.id === id ? { ...h, ...patch } : h)))
  const [newId, setNewId] = useState('')
  return (
    <>
      <h2 className="sys-title">Harnesses</h2>
      <p className="mute">The coding-agent CLIs units run. Unverified adapters are allowed but may need a hand in their terminal.</p>
      <div className="harness-list">
        {s.harnesses.map((h) => (
          <div key={h.id} className={cx('harness panel', !h.enabled && 'off')}>
            <div className="harness-head">
              <Toggle checked={h.enabled} onChange={(v) => upd(h.id, { enabled: v })} />
              <b>{h.name}</b>
              <span className="mono mute">{h.id}</span>
              {h.verified ? <span className="chip volt">verified</span> : <span className="chip amber">unverified</span>}
              {h.role === 'worker' && <span className="chip">units only</span>}
              <span style={{ flex: 1 }} />
              {!h.builtin && (
                <button className="btn sm ghost icon alert" onClick={() => save(s.harnesses.filter((x) => x.id !== h.id))}>
                  <Trash size={12} />
                </button>
              )}
            </div>
            <div className="harness-fields">
              <Field label="Command">
                <CommitInput mono value={h.command} onCommit={(v) => upd(h.id, { command: v.trim() })} />
              </Field>
              <Field label="Args" hint="Tokens: {model} {effort} {prompt} {cwd}">
                <CommitInput mono value={h.args.join(' ')} onCommit={(v) => upd(h.id, { args: v.split(/\s+/).filter(Boolean) })} />
              </Field>
              <Field label="Resume args">
                <CommitInput mono value={(h.resumeArgs ?? []).join(' ')} onCommit={(v) => upd(h.id, { resumeArgs: v.split(/\s+/).filter(Boolean) })} />
              </Field>
              <Field label="Exit">
                <CommitInput mono value={h.exitSequence} onCommit={(v) => upd(h.id, { exitSequence: v })} />
              </Field>
              <Field label="Models">
                <CommitInput mono value={h.models.join(', ')} onCommit={(v) => upd(h.id, { models: v.split(/[,\s]+/).filter(Boolean) })} />
              </Field>
            </div>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12, maxWidth: 420 }}>
        <input className="input mono" value={newId} placeholder="custom-harness-id" onChange={(e) => setNewId(e.target.value.replace(/[^\w-]/g, ''))} />
        <button
          className="btn"
          disabled={!newId || s.harnesses.some((h) => h.id === newId)}
          onClick={() => {
            save([
              ...s.harnesses,
              {
                id: newId,
                name: newId,
                command: newId,
                args: ['{prompt}'],
                promptDelivery: 'arg',
                interrupt: '\u001b',
                exitSequence: '/exit',
                trustPatterns: [],
                trustResponse: '\r',
                submitKey: '\r',
                verified: false,
                role: 'worker',
                models: [],
                builtin: false,
                enabled: true
              }
            ])
            setNewId('')
          }}
        >
          <Plus size={13} /> Add custom
        </button>
      </div>
    </>
  )
}

function Dispatch({ s }: { s: Settings }) {
  const projects = useStore((st) => st.snap.projects)
  const save = (rules: DispatchRule[]): void => set({ dispatchRules: rules })
  const upd = (id: string, patch: Partial<DispatchRule>): void => save(s.dispatchRules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const harnessOpts = s.harnesses.filter((h) => h.enabled)
  const [scores, setScores] = useState<DispatchScoresView | null>(null)
  useEffect(() => {
    void api().dispatchScores().then(setScores).catch(() => setScores(null))
  }, [s.categoryPools, s.dispatchRules])
  return (
    <>
      <h2 className="sys-title">Dispatch</h2>
      <p className="mute">
        How Genio picks a unit tool, model and effort. Precedence: your (or Genio's) explicit per-mission pick, then a follow-up's original loadout, then the best-fit rule below, then the
        category table, then the Units default. Unlocked table rows follow the Usage mode; a locked row is Pinned and used as written. Tools that aren't installed or logged in are skipped, and a subscription at
        {' '}{QUOTA_HOT_PERCENT}% or more of its 5-hour or weekly window is excluded. Exploration is set by the Usage mode.
      </p>
      <Row
        label="Learn the order automatically"
        hint={`Swaps two neighbouring candidates when both have ${LEARNING.minSamples}+ outcomes and the lower one scores ${LEARNING.reorderMargin} higher (scores 0-1, recency half-life ${LEARNING.halfLifeDays} days). Adding or removing candidates always waits for your OK in Pending answers. Locked rows and rules are never touched.`}
      >
        <Toggle checked={s.autoReorder} onChange={(v) => set({ autoReorder: v })} />
      </Row>

      <CategoryTable s={s} scores={scores} />

      <div className="label" style={{ margin: '22px 0 8px' }}>
        Rules
      </div>
      <p className="mute">Explicit rules beat the category table. First matching rule wins; higher spend priority is tried first among candidates.</p>
      {s.dispatchRules.length === 0 && <div className="mute side-empty">No rules — the category table decides.</div>}
      {s.dispatchRules.map((r) => (
        <div key={r.id} className="rule panel">
          <div className="rule-head locks">
            <Field label="When the mission mentions">
              <CommitInput value={r.match} placeholder="(always)" onCommit={(v) => upd(r.id, { match: v })} />
            </Field>
            <Field label="Kind">
              <select className="select" value={r.kind ?? 'any'} onChange={(e) => upd(r.id, { kind: e.target.value as DispatchRule['kind'] })}>
                <option value="any">Any</option>
                <option value="ship">Build</option>
                <option value="scout">Recon</option>
              </select>
            </Field>
            <Field label="Project">
              <select className="select" value={r.project ?? ''} onChange={(e) => upd(r.id, { project: e.target.value || undefined })}>
                <option value="">Any</option>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <LockButton locked={!!r.locked} onChange={(v) => upd(r.id, { locked: v || undefined })} />
            <button className="btn sm ghost icon alert" title="Remove rule" onClick={() => save(s.dispatchRules.filter((x) => x.id !== r.id))}>
              <Trash size={12} />
            </button>
          </div>
          <div className="label" style={{ margin: '10px 0 6px' }}>
            Candidates
          </div>
          {r.candidates.map((c, i) => {
            const updC = (patch: Partial<DispatchRule['candidates'][number]>): void => upd(r.id, { candidates: r.candidates.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
            return (
              <div key={i} className="cand-row">
                <select className="select" value={c.harness} onChange={(e) => updC({ harness: e.target.value })}>
                  {harnessOpts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
                <CommitInput mono value={c.model ?? ''} placeholder="model" onCommit={(v) => updC({ model: v.trim() || undefined })} />
                <select className="select" value={c.effort ?? ''} onChange={(e) => updC({ effort: e.target.value || undefined })}>
                  <option value="">effort</option>
                  {EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
                <CommitInput type="number" value={c.spendPriority} onCommit={(v) => updC({ spendPriority: Number(v) || 0 })} />
                <button className="btn sm ghost icon" onClick={() => upd(r.id, { candidates: r.candidates.filter((_, j) => j !== i) })}>
                  <Trash size={12} />
                </button>
              </div>
            )
          })}
          <button className="btn sm ghost" onClick={() => upd(r.id, { candidates: [...r.candidates, { harness: s.defaultHarness, spendPriority: 0 }] })}>
            <Plus size={12} /> Candidate
          </button>
        </div>
      ))}
      <button
        className="btn"
        onClick={() => save([...s.dispatchRules, { id: `rule-${Date.now().toString(36)}`, match: '', kind: 'any', candidates: [{ harness: s.defaultHarness, spendPriority: 0 }] }])}
      >
        <Plus size={13} /> Add rule
      </button>

      <Scores scores={scores} />
    </>
  )
}

function LockButton({ locked, onChange }: { locked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={cx('btn sm ghost icon', locked && 'amber')}
      title={locked ? 'Pinned: the Usage mode and the learning loop never change this' : 'Pin so the Usage mode and the learning loop never change this'}
      onClick={() => onChange(!locked)}
    >
      {locked ? <Lock size={12} /> : <LockOpen size={12} />}
    </button>
  )
}

function CategoryTable({ s, scores }: { s: Settings; scores: DispatchScoresView | null }) {
  const harnessOpts = s.harnesses.filter((h) => h.enabled)
  const [reset, setReset] = useState(false)
  const savePools = (pools: CategoryPool[]): void => set({ categoryPools: pools })
  const updPool = (cat: string, patch: Partial<CategoryPool>): void => savePools(s.categoryPools.map((p) => (p.category === cat ? { ...p, ...patch } : p)))
  const scoreOf = (cat: string, c: PoolCandidate): ScoreRow | undefined =>
    scores?.rows.find((r) => r.scope === cat && r.harness === c.harness && (r.model ?? '') === (c.model ?? ''))
  return (
    <>
      <div className="label" style={{ margin: '22px 0 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
        Category table
        <button className="btn sm ghost" onClick={() => setReset(true)}>
          <RefreshCw size={11} /> Reset to defaults
        </button>
      </div>
      <p className="mute">
        Genio passes the category at deploy; the Deploy window guesses it from keywords and lets you override. The first available candidate wins. Cheap OpenRouter models (OpenCode) are used only with
        the OpenRouter key and in projects that allow them.
      </p>
      <div className="cat-table">
        {s.categoryPools.map((p) => {
          const meta = CATEGORIES.find((c) => c.id === p.category)
          const setCands = (candidates: PoolCandidate[]): void => updPool(p.category, { candidates })
          return (
            <div key={p.category} className={cx('cat-row panel', p.locked && 'locked')}>
              <div className="cat-head">
                <b>{meta?.label ?? p.category}</b>
                <span className="mute">{meta?.hint}</span>
                <span style={{ flex: 1 }} />
                <LockButton locked={!!p.locked} onChange={(v) => updPool(p.category, { locked: v || undefined })} />
              </div>
              {p.candidates.map((c, i) => {
                const updC = (patch: Partial<PoolCandidate>): void => setCands(p.candidates.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                const move = (by: number): void => {
                  const next = p.candidates.slice()
                  const [it] = next.splice(i, 1)
                  next.splice(i + by, 0, it)
                  setCands(next)
                }
                const sc = scoreOf(p.category, c)
                return (
                  <div key={i} className="cand-row cat-cand">
                    <span className="mono mute">{i + 1}</span>
                    <select className="select" value={c.harness} onChange={(e) => updC({ harness: e.target.value })}>
                      {harnessOpts.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                        </option>
                      ))}
                    </select>
                    <CommitInput mono value={c.model ?? ''} placeholder="tool default model" onCommit={(v) => updC({ model: v.trim() || undefined })} />
                    <select className="select" value={c.effort ?? ''} onChange={(e) => updC({ effort: e.target.value || undefined })}>
                      <option value="">effort</option>
                      {EFFORTS.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                    <button className={cx('chip', c.cheap && 'amber')} title="Cheap third-party model: needs the OpenRouter key; projects can opt out" onClick={() => updC({ cheap: !c.cheap || undefined })}>
                      cheap
                    </button>
                    <span className="mono mute cat-score" title={sc ? `${sc.landed}/${sc.samples} landed` : 'no outcomes yet'}>
                      {sc ? `${sc.score.toFixed(2)} · ${sc.samples}` : '—'}
                    </span>
                    <button className="btn sm ghost icon" disabled={i === 0} title="Move up" onClick={() => move(-1)}>
                      <ChevronUp size={12} />
                    </button>
                    <button className="btn sm ghost icon" disabled={i === p.candidates.length - 1} title="Move down" onClick={() => move(1)}>
                      <ChevronDown size={12} />
                    </button>
                    <button className="btn sm ghost icon" title="Remove" onClick={() => setCands(p.candidates.filter((_, j) => j !== i))}>
                      <Trash size={12} />
                    </button>
                  </div>
                )
              })}
              <button className="btn sm ghost" onClick={() => setCands([...p.candidates, { harness: s.defaultHarness }])}>
                <Plus size={12} /> Candidate
              </button>
            </div>
          )
        })}
      </div>
      {reset && (
        <Confirm
          title="Reset the category table?"
          tone="amber"
          confirmLabel="Reset"
          body="Every category row goes back to the shipped defaults, including learned order and locks. Rules are kept."
          onConfirm={() => savePools(defaultCategoryPools())}
          onClose={() => setReset(false)}
        />
      )}
    </>
  )
}

function Scores({ scores }: { scores: DispatchScoresView | null }) {
  if (!scores) return null
  const scopeLabel = (scope: string): string => (scope.startsWith('rule:') ? `rule ${scope.slice(5)}` : categoryLabel(scope))
  return (
    <>
      <div className="label" style={{ margin: '22px 0 8px' }}>
        Scorecard
      </div>
      <p className="mute">Recency-weighted score per category, tool and model: landed work scores high, steering pings, respawns, Gauntlet fix rounds and lagging pull it down, and your 👍/👎 weighs most.</p>
      {scores.rows.length === 0 ? (
        <div className="mute side-empty">No outcomes yet. Every unit that lands, is despawned or fails adds one.</div>
      ) : (
        <div className="score-grid mono">
          <span className="mute">category</span>
          <span className="mute">tool / model</span>
          <span className="mute">score</span>
          <span className="mute">landed</span>
          {scores.rows.map((r) => (
            <Fragment key={`${r.scope}|${r.harness}|${r.model ?? ''}`}>
              <span>{scopeLabel(r.scope)}</span>
              <span>
                {r.harness}
                {r.model ? ` / ${r.model}` : ''}
              </span>
              <div className="bar" title={r.score.toFixed(2)}>
                <i style={{ width: `${Math.round(r.score * 100)}%`, ['--c' as string]: r.score >= 0.7 ? 'var(--volt)' : r.score >= 0.4 ? 'var(--amber)' : 'var(--alert)' }} />
              </div>
              <span>
                {r.landed}/{r.samples}
              </span>
            </Fragment>
          ))}
        </div>
      )}
      {scores.log.length > 0 && (
        <>
          <div className="label" style={{ margin: '16px 0 6px' }}>
            Learning log
          </div>
          <div className="learning-log">
            {scores.log.map((e, i) => (
              <div key={i}>
                <span className="mono mute">{dateShort(e.ts)}</span> <span className={cx('chip', e.kind === 'reorder' ? 'neon' : e.kind === 'applied' ? 'volt' : 'amber')}>{e.kind}</span> {e.text}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function Triggers({ s }: { s: Settings }) {
  const save = (list: EventSource[]): void => set({ eventSources: list })
  const upd = (id: string, patch: Partial<EventSource>): void => save(s.eventSources.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  return (
    <>
      <h2 className="sys-title">Triggers</h2>
      <p className="mute">Commands Overwatch runs on a timer. When one fires, Genio gets an event — e.g. a nightly build check, an itch.io butler status, a Steam depot poll.</p>
      {s.eventSources.map((e) => (
        <div key={e.id} className="rule panel">
          <div className="rule-head">
            <Toggle checked={e.enabled} onChange={(v) => upd(e.id, { enabled: v })} />
            <Field label="Name">
              <CommitInput value={e.name} onCommit={(v) => upd(e.id, { name: v })} />
            </Field>
            <Field label="Every (s)">
              <CommitInput type="number" value={e.intervalSec} onCommit={(v) => upd(e.id, { intervalSec: num(v, 10) })} />
            </Field>
            <Field label="Fire when">
              <select className="select" value={e.trigger} onChange={(ev) => upd(e.id, { trigger: ev.target.value as EventSource['trigger'] })}>
                <option value="nonzero">Exit code ≠ 0</option>
                <option value="change">Output changes</option>
                <option value="match">Output matches</option>
              </select>
            </Field>
            <button className="btn sm ghost icon alert" onClick={() => save(s.eventSources.filter((x) => x.id !== e.id))}>
              <Trash size={12} />
            </button>
          </div>
          <div className="trigger-fields">
            <Field label="Command">
              <CommitInput mono value={e.command} onCommit={(v) => upd(e.id, { command: v })} />
            </Field>
            <Field label="Working dir">
              <CommitInput mono value={e.cwd ?? ''} placeholder="(base)" onCommit={(v) => upd(e.id, { cwd: v.trim() || undefined })} />
            </Field>
            {e.trigger === 'match' && (
              <Field label="Pattern (regex)">
                <CommitInput mono value={e.pattern ?? ''} onCommit={(v) => upd(e.id, { pattern: v })} />
              </Field>
            )}
          </div>
          {e.lastRunAt && <div className="mute mono" style={{ fontSize: 11 }}>last run {dateShort(e.lastRunAt)} · {(e.lastOutput ?? '').slice(0, 120)}</div>}
        </div>
      ))}
      <button
        className="btn"
        onClick={() => save([...s.eventSources, { id: `trig-${Date.now().toString(36)}`, name: 'New trigger', command: '', intervalSec: 300, trigger: 'nonzero', enabled: false }])}
      >
        <Plus size={13} /> Add trigger
      </button>
    </>
  )
}

function Toolchain() {
  const [tools, setTools] = useState<ToolStatus[] | null>(null)
  const [confirm, setConfirm] = useState<ToolStatus | null>(null)
  const load = (): void => {
    setTools(null)
    void api().toolchain().then(setTools).catch((e) => {
      toast('error', 'Loadout check failed', errText(e))
      setTools([])
    })
  }
  useEffect(load, [])
  return (
    <>
      <h2 className="sys-title">
        Loadout
        <button className="btn sm ghost" style={{ marginLeft: 12 }} onClick={load}>
          <RefreshCw size={12} /> Rescan
        </button>
      </h2>
      <p className="mute">Tools Genio and its units use. Installs run only when you click.</p>
      {!tools && (
        <div className="bar indeterminate">
          <i />
        </div>
      )}
      <div className="tool-list">
        {tools?.map((t) => (
          <div key={t.name} className="tool-row">
            <span className="dot" style={{ ['--c' as string]: t.found ? 'var(--volt)' : t.required ? 'var(--alert)' : 'var(--text-mute)' }} />
            <b className="mono">{t.name}</b>
            <span className="mute tool-purpose">{t.purpose}</span>
            <span className="mono mute" title={t.path}>
              {t.found ? t.version ?? 'found' : t.required ? 'missing · required' : 'missing'}
            </span>
            {!t.found && t.install ? (
              <button className="btn sm" onClick={() => setConfirm(t)}>
                <Download size={12} /> Install
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      {confirm && (
        <Confirm
          title={`Install ${confirm.name}?`}
          tone="amber"
          confirmLabel="Install"
          body={
            <>
              Genio will run:
              <pre className="file-pre selectable">{confirm.install}</pre>
            </>
          }
          onConfirm={async () => {
            await op(`Install ${confirm.name}`, () => api().installTool(confirm.name))
            load()
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  )
}

const LOGIN_LABEL: Record<AccountStatus['state'], { text: string; tone: string }> = {
  'logged-in': { text: 'logged in', tone: 'volt' },
  'logged-out': { text: 'logged out', tone: 'amber' },
  unknown: { text: 'unknown', tone: '' }
}

function Accounts() {
  const [accounts, setAccounts] = useState<AccountStatus[] | null>(null)
  const [keys, setKeys] = useState<ApiKeyStatus[]>([])
  const [session, setSession] = useState<string | null>(null)
  const [logout, setLogout] = useState<AccountStatus | null>(null)
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const { view: policy, error: policyError } = useUsagePolicyState()
  const sessionTerm = useStore((s) => (session ? s.terminals[session] : undefined))
  // read on opening the screen and on Refresh only: no background polling
  const load = (): void => {
    setAccounts(null)
    void api().accounts().then(setAccounts).catch((e) => {
      toast('error', 'Account check failed', errText(e))
      setAccounts([])
    })
    void api().apiKeys().then(setKeys).catch(() => setKeys([]))
    void api()
      .accountUsage()
      .then(setUsage)
      .catch((e) => toast('error', 'Usage check failed', errText(e)))
  }
  useEffect(load, [])
  // the login/logout flow finished: re-read every status
  const ended = Boolean(session && sessionTerm && !sessionTerm.alive)
  useEffect(() => {
    if (ended) load()
  }, [ended])
  const start = async (a: AccountStatus, action: 'login' | 'logout'): Promise<void> => {
    try {
      if (session) await api().terminalKill(session)
      const t = await api().accountSession(a.tool, action)
      setSession(t.id)
    } catch (e) {
      toast('error', `${action === 'login' ? 'Log in' : 'Log out'} · ${a.label}`, errText(e))
    }
  }
  const close = (): void => {
    if (session) void api().terminalKill(session).catch(() => undefined)
    setSession(null)
  }
  return (
    <>
      <h2 className="sys-title">
        Accounts
        <button className="btn sm ghost" style={{ marginLeft: 12 }} onClick={load}>
          <RefreshCw size={12} /> Refresh
        </button>
      </h2>
      <p className="mute">Sign in to the CLIs Genio and its units drive. Each login runs the tool's own flow; the tool keeps its credentials and Genio never reads them. Usage comes from what each tool reports and from local session logs.</p>
      <PlanMeter view={policy} error={policyError} />
      {usage && <WorldAttribution usage={usage} />}
      {!accounts && (
        <div className="bar indeterminate">
          <i />
        </div>
      )}
      <div className="tool-list account-list">
        {accounts?.map((a) => {
          const st = LOGIN_LABEL[a.state]
          const actions = accountActions(a)
          const u = a.installed ? usage?.tools.find((t) => t.tool === a.tool) : undefined
          return (
            <div key={a.tool} className="tool-row account-row">
              <span className="dot" style={{ ['--c' as string]: !a.installed ? 'var(--text-mute)' : a.state === 'logged-in' ? 'var(--volt)' : a.state === 'logged-out' ? 'var(--amber)' : 'var(--text-dim)' }} />
              <b className="mono">{a.tool}</b>
              <div className="account-main">
                <div>
                  {a.label}
                  {!a.verified && (
                    <span className="chip" style={{ marginLeft: 8 }} title="Auth commands wired from the tool's documentation; not yet checked against an installed copy.">
                      documented
                    </span>
                  )}
                </div>
                {a.installed ? (
                  <>
                    <div className="mute tool-purpose">{a.detail ?? a.note ?? a.purpose}</div>
                    {u && (
                      <button className="usage-toggle mono" title="Plan limits and token usage" onClick={() => setOpen((o) => ({ ...o, [a.tool]: !o[a.tool] }))}>
                        {open[a.tool] ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Usage · {usageSummary(u)}
                      </button>
                    )}
                  </>
                ) : (
                  <div className="mute tool-purpose">
                    not installed{a.install && <> · <span className="mono selectable">{a.install}</span></>}
                  </div>
                )}
              </div>
              {a.installed ? <span className={cx('chip', st.tone)}>{st.text}</span> : <span />}
              <div className="row account-actions">
                {actions.login && (
                  <button className="btn sm" onClick={() => void start(a, 'login')}>
                    <LogIn size={12} /> Log in
                  </button>
                )}
                {actions.logout && (
                  <button className="btn sm ghost" onClick={() => setLogout(a)}>
                    <LogOut size={12} /> Log out
                  </button>
                )}
              </div>
              {u && open[a.tool] && <UsageDetails u={u} />}
            </div>
          )
        })}
      </div>
      {session && (
        <div className="account-session panel">
          <div className="account-session-head">
            <b>{sessionTerm?.title ?? 'Session'}</b>
            <span className="mute">{sessionTerm && !sessionTerm.alive ? `exited (${sessionTerm.exitCode ?? '?'})` : 'finish any prompts here or in your browser'}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm ghost icon" title="Close" onClick={close}>
              <X size={12} />
            </button>
          </div>
          <div className="account-term">
            <TerminalView id={session} autoFocus />
          </div>
        </div>
      )}
      <div className="label" style={{ margin: '22px 0 8px' }}>
        API keys
      </div>
      <p className="mute">For services without a CLI login. Keys are encrypted with your OS keychain and stay in Genio's base; Genio shows only whether one is set. Units get a key only through their process environment: FAL as FAL_KEY, OpenRouter as OPENROUTER_API_KEY for OpenCode units in projects that allow cheap third-party models. The Uthana key stays in Genio's core for the Animation screen.</p>
      {keys.map((k) => (
        <ApiKeyRow key={k.id} k={k} spend={k.id === 'fal' ? usage?.fal : undefined} onChange={() => void api().apiKeys().then(setKeys).catch(() => undefined)} />
      ))}
      {logout && (
        <Confirm
          title={`Log out of ${logout.label}?`}
          tone="amber"
          confirmLabel="Log out"
          body={`Runs ${logout.tool}'s own logout. Units using ${logout.label} will need you to log in again.`}
          onConfirm={() => start(logout, 'logout')}
          onClose={() => setLogout(null)}
        />
      )}
    </>
  )
}

const tokens = (n: number): string => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : n < 1e9 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e9).toFixed(2)}B`)
const pct = (n: number): string => `${Math.round(n)}%`
const resetTime = (iso: string): string => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** One line for the collapsed row: current plan windows, else what Genio measured today. */
function usageSummary(u: ToolUsage): string {
  if (u.error) return 'could not read'
  const live = (u.limits[0]?.windows ?? []).filter((w) => !w.stale && (w.usedPercent !== undefined || w.status === 'rejected'))
  const parts = live.map((w) => `${w.label} ${w.usedPercent !== undefined ? pct(w.usedPercent) : 'limit reached'}`)
  if (u.measured) parts.push(`Genio today ${tokens(u.measured.today.total)} tok`)
  return parts.join(' · ') || 'details'
}

function UsageDetails({ u }: { u: ToolUsage }) {
  return (
    <div className="account-usage">
      {u.error && <div className="alert-text">Could not read usage: {u.error}</div>}
      {u.limits.map((l, i) => (
        <div key={i} className="usage-block">
          <div className="usage-head">
            <b>{l.name ? `Plan limits · ${l.name}` : 'Plan limits'}</b>
            {l.plan && <span className="chip">{l.plan}</span>}
            <span className="mute">
              {l.source} · updated {ago(l.updatedAt)} ago
            </span>
          </div>
          {l.windows.map((w) => (
            <div key={w.label} className={cx('usage-window', w.stale && 'stale')} title={w.observedAt ? `Observed ${ago(w.observedAt)} ago` : 'Observation time unknown'}>
              <span className="mono">{w.label}</span>
              {w.usedPercent !== undefined ? (
                <div className="bar" title={`${w.usedPercent}% used`}>
                  <i style={{ width: `${Math.min(100, w.usedPercent)}%`, ['--c' as string]: w.usedPercent >= 90 ? 'var(--alert)' : w.usedPercent >= 70 ? 'var(--amber)' : 'var(--volt)' }} />
                </div>
              ) : (
                <span className="mute">{w.stale ? 'unknown (old observation)' : w.status === 'rejected' ? 'limit reached' : w.status === 'allowed_warning' ? 'nearing the limit' : w.status === 'allowed' ? 'within the limit' : 'unknown'}</span>
              )}
              <span className="mono">{w.usedPercent !== undefined ? pct(w.usedPercent) : ''}</span>
              <span className="mute">{w.resetsAt ? (Date.parse(w.resetsAt) <= Date.now() ? `reset ${resetTime(w.resetsAt)}; no newer snapshot` : `resets ${resetTime(w.resetsAt)}`) : ''}</span>
            </div>
          ))}
        </div>
      ))}
      {u.note && <div className="mute">{u.note}</div>}
      {u.measured && (
        <div className="usage-block">
          <div className="usage-head">
            <b>Tokens</b>
            <span className="mute">
              {u.measured.source} · {u.measured.scope} · updated {clock(u.measured.updatedAt)}
            </span>
          </div>
          <div className="usage-tokens mono">
            <span />
            <span className="mute">total</span>
            <span className="mute">input</span>
            <span className="mute">cache read</span>
            <span className="mute">output</span>
            <span className="mute">sessions</span>
            {(
              [
                ['today', u.measured.today],
                ['7 days', u.measured.week]
              ] as const
            ).map(([label, t]) => (
              <Fragment key={label}>
                <span className="mute">{label}</span>
                <b>{tokens(t.total)}</b>
                <span>{tokens(t.input)}</span>
                <span>{tokens(t.cached)}</span>
                <span>{tokens(t.output)}</span>
                <span>{t.sessions}</span>
              </Fragment>
            ))}
          </div>
          <div className="mute">Counted by Genio from local session logs; not the official plan figure.</div>
        </div>
      )}
    </div>
  )
}

function falSpendLine(s: FalSpend): string {
  if (!s.runs) return 'no FAL runs in the last 7 days'
  if (!s.costed) return `${s.runs} run${s.runs === 1 ? '' : 's'} in 7 days; FAL reported no costs`
  const partial = s.costed < s.runs ? ` (${s.costed} of ${s.runs} runs costed)` : ''
  return `spend today ${usd(s.todayUsd)} · 7 days ${usd(s.weekUsd)}${partial} · ${s.source}`
}

function ApiKeyRow({ k, spend, onChange }: { k: ApiKeyStatus; spend?: FalSpend; onChange: () => void }) {
  const [v, setV] = useState('')
  const [clear, setClear] = useState(false)
  const save = async (): Promise<void> => {
    const r = await op(`${k.label} key`, () => api().apiKeySet(k.id, v))
    if (r?.ok) setV('')
    onChange()
  }
  return (
    <Row
      label={k.label}
      hint={
        <>
          {k.purpose}
          <br />
          <KeyRound size={11} style={{ verticalAlign: -1 }} /> {k.set ? <span className="volt-text">key set{k.last4 ? ` · ••••${k.last4}` : ''}</span> : 'no key'}
          {k.set && k.setAt && <> · {dateShort(k.setAt)}</>}
          {spend && (
            <>
              <br />
              {falSpendLine(spend)}
            </>
          )}
        </>
      }
    >
      <div className="row">
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={v}
          placeholder={k.set ? 'Paste a new key to replace' : 'Paste API key'}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && v.trim() && void save()}
        />
        <button className="btn sm solid" disabled={!v.trim()} onClick={() => void save()}>
          {k.set ? 'Replace' : 'Save'}
        </button>
        <button className="btn sm ghost alert" disabled={!k.set} onClick={() => setClear(true)}>
          Clear
        </button>
      </div>
      {clear && (
        <Confirm
          title={`Clear the ${k.label} key?`}
          tone="alert"
          confirmLabel="Clear"
          body="The stored key is deleted from Genio's base."
          onConfirm={async () => {
            await op(`${k.label} key`, () => api().apiKeyClear(k.id))
            onChange()
          }}
          onClose={() => setClear(false)}
        />
      )}
    </Row>
  )
}

function Patch() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      setInfo(await api().checkUpdate())
    } catch (e) {
      toast('error', 'Patch check failed', errText(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void check()
  }, [])
  return (
    <>
      <h2 className="sys-title">Patch</h2>
      <p className="mute">Fast-forward-only self update of Genio's own checkout. Never touches your projects. Allies restart on the new build.</p>
      <button className="btn" disabled={busy} onClick={() => void check()}>
        <RefreshCw size={13} className={busy ? 'spin' : ''} /> Check for patch
      </button>
      {info && (
        <div className="patch panel" style={{ marginTop: 14 }}>
          {!info.isGitCheckout ? (
            <div className="mute">This install is not a git checkout; patch by reinstalling.</div>
          ) : (
            <>
              <div className="patch-stats">
                <div>
                  <div className="label">Branch</div>
                  <div className="mono">{info.branch}</div>
                </div>
                <div>
                  <div className="label">Behind</div>
                  <div className={cx('num big-num', info.behind > 0 && 'neon-text')}>{info.behind}</div>
                </div>
                <div>
                  <div className="label">Ahead</div>
                  <div className="num big-num">{info.ahead}</div>
                </div>
                <div>
                  <div className="label">Local changes</div>
                  <div className={info.dirty ? 'amber-text' : 'volt-text'}>{info.dirty ? 'yes' : 'clean'}</div>
                </div>
              </div>
              {info.error && <div className="alert-text mono" style={{ fontSize: 12 }}>{info.error}</div>}
              {info.incoming.length > 0 && (
                <>
                  <div className="label" style={{ margin: '14px 0 6px' }}>
                    Incoming
                  </div>
                  <ul className="patch-list mono">
                    {info.incoming.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </>
              )}
              {info.behind === 0 ? (
                <div className="volt-text" style={{ marginTop: 12 }}>
                  <Wrench size={13} /> Up to date.
                </div>
              ) : (
                <button className="btn solid" style={{ marginTop: 12 }} disabled={!info.canFastForward} onClick={() => setConfirm(true)}>
                  Apply patch & restart
                </button>
              )}
              {info.behind > 0 && !info.canFastForward && <div className="amber-text" style={{ marginTop: 8 }}>Cannot fast-forward cleanly (local changes or divergence).</div>}
            </>
          )}
        </div>
      )}
      {confirm && (
        <Confirm
          title="Apply patch?"
          tone="neon"
          confirmLabel="Patch & restart"
          body="Genio fast-forwards, reinstalls dependencies if needed and restarts. Units keep their isolated copies and respawn on the new build."
          onConfirm={async () => {
            await op('Patch', () => api().applyUpdate())
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  )
}
