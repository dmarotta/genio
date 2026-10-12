import { useEffect, useState, type ReactNode } from 'react'
import { Copy, Download, Plus, RefreshCw, Trash, TriangleAlert, Users, Wrench } from 'lucide-react'
import type { DispatchRule, EventSource, HarnessAdapter, Settings, ToolStatus, UpdateInfo } from '@shared/types'
import { api, errText, op, saveSettings, toast, useStore } from '../store'
import { CommitInput, Confirm, Field, Toggle, ViewHeader } from '../components/ui'
import { EFFORTS, MODEL_SUGGESTIONS } from '../lib/vocab'
import { cx, dateShort } from '../lib/format'
import { playSfx } from '../lib/sfx'

type Section =
  | 'profile' | 'genio' | 'units' | 'overwatch' | 'gauntlet' | 'comms' | 'alerts' | 'mail' | 'memory'
  | 'harnesses' | 'dispatch' | 'triggers' | 'toolchain' | 'allies' | 'patch'

const SECTIONS: { id: Section; label: string; group: string }[] = [
  { id: 'profile', label: 'Profile', group: 'Player' },
  { id: 'comms', label: 'Comms & FX', group: 'Player' },
  { id: 'alerts', label: 'Alerts', group: 'Player' },
  { id: 'genio', label: 'Genio', group: 'Squad' },
  { id: 'units', label: 'Units', group: 'Squad' },
  { id: 'harnesses', label: 'Harnesses', group: 'Squad' },
  { id: 'dispatch', label: 'Dispatch rules', group: 'Squad' },
  { id: 'allies', label: 'Allies', group: 'Squad' },
  { id: 'overwatch', label: 'Overwatch', group: 'Engine' },
  { id: 'gauntlet', label: 'Gauntlet', group: 'Engine' },
  { id: 'triggers', label: 'Triggers', group: 'Engine' },
  { id: 'memory', label: 'Memory & briefs', group: 'Engine' },
  { id: 'mail', label: 'Mail & replay', group: 'Engine' },
  { id: 'toolchain', label: 'Loadout', group: 'Base' },
  { id: 'patch', label: 'Patch', group: 'Base' }
]

let pendingSection: Section | null = null
export function requestSystemsSection(s: Section): void {
  pendingSection = s
}

export function Systems() {
  const settings = useStore((s) => s.settings)
  const [sec, setSec] = useState<Section>(() => {
    const p = pendingSection
    pendingSection = null
    return p ?? 'profile'
  })
  const [home, setHome] = useState('')
  useEffect(() => {
    void api().homePath().then(setHome).catch(() => undefined)
  }, [])
  if (!settings) return <div className="view"><div className="bar indeterminate"><i /></div></div>

  let lastGroup = ''
  return (
    <div className="view">
      <ViewHeader
        kicker={home ? `Base · ${home}` : 'Configuration'}
        title={
          <>
            <span className="accent">Systems</span>
          </>
        }
      />
      <div className="sys-layout">
        <nav className="sys-nav">
          {SECTIONS.map((s) => {
            const head = s.group !== lastGroup
            lastGroup = s.group
            return (
              <div key={s.id}>
                {head && <div className="label sys-group">{s.group}</div>}
                <button className={cx('sys-link', sec === s.id && 'on')} onClick={() => setSec(s.id)}>
                  {s.label}
                </button>
              </div>
            )
          })}
        </nav>
        <div className="sys-body panel">
          <SectionBody sec={sec} s={settings} />
        </div>
      </div>
    </div>
  )
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

function SectionBody({ sec, s }: { sec: Section; s: Settings }) {
  switch (sec) {
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
          <ModelRow label="Genio model" hint="Model for the companion you talk to." value={s.wkspModel} onCommit={(v) => set({ wkspModel: v })} />
          <Row label="Genio effort">
            <EffortSelect value={s.wkspEffort} onChange={(v) => set({ wkspEffort: v })} />
          </Row>
          <ModelRow label="Bot model" hint="Handles events while you're DND/AFK. A cheaper model is fine." value={s.botModel} onCommit={(v) => set({ botModel: v })} />
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
          <ModelRow label="Default model" value={s.defaultWorkerModel} onCommit={(v) => set({ defaultWorkerModel: v })} />
          <Row label="Default effort" hint="Blank lets Genio choose: low for clear work, higher for ambiguous design.">
            <EffortSelect value={s.defaultWorkerEffort} onChange={(v) => set({ defaultWorkerEffort: v })} />
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
          <Row label="Max respawns" hint="Automatic respawn attempts per unit.">
            <CommitInput type="number" value={s.maxRelaunches} onCommit={(v) => set({ maxRelaunches: num(v) })} />
          </Row>
          <Row label="Strip AI commit trailers">
            <Toggle checked={s.stripAiTrailers} onChange={(v) => set({ stripAiTrailers: v })} />
          </Row>
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
          <NumRow label="Tick base (min)" value={s.heartbeatBaseMinutes} onCommit={(v) => set({ heartbeatBaseMinutes: num(v, 1) })} />
          <NumRow label="Tick max (min)" value={s.heartbeatMaxMinutes} onCommit={(v) => set({ heartbeatMaxMinutes: num(v, 1) })} />
          <NumRow label="PR poll (min)" value={s.prPollMinutes} onCommit={(v) => set({ prPollMinutes: num(v, 1) })} />
          <NumRow label="Event grace (s)" hint="Coalesce status lines." value={s.signalGraceSeconds} onCommit={(v) => set({ signalGraceSeconds: num(v) })} />
          <NumRow label="Ping re-ring (s)" value={s.inboxGraceSeconds} onCommit={(v) => set({ inboxGraceSeconds: num(v, 10) })} />
          <NumRow label="Ping rings before escalating" value={s.inboxRingMax} onCommit={(v) => set({ inboxRingMax: num(v, 1) })} />
        </>
      )
    case 'gauntlet':
      return (
        <>
          <h2 className="sys-title">Gauntlet</h2>
          <p className="mute">Hardcore validation: checks, AI review against your words, fix rounds, push, PR, CI.</p>
          <ModelRow label="Reviewer model" value={s.reviewModel} onCommit={(v) => set({ reviewModel: v })} />
          <NumRow label="Max fix rounds" value={s.validationMaxRounds} onCommit={(v) => set({ validationMaxRounds: num(v, 1) })} />
        </>
      )
    case 'memory':
      return (
        <>
          <h2 className="sys-title">Memory & briefs</h2>
          <NumRow label="Memory budget (tokens)" hint="Player Profile + Lore kept under this on /save." value={s.memoryBudgetTokens} onCommit={(v) => set({ memoryBudgetTokens: num(v, 500) })} />
          <div className="sys-row col">
            <div className="sys-row-title">Brief additions</div>
            <div className="mute sys-row-hint">Appended to every unit brief.</div>
            <BriefInclude value={s.briefInclude} />
          </div>
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
    case 'allies':
      return <Allies />
    case 'patch':
      return <Patch />
  }
}

function NumRow({ label, hint, value, onCommit }: { label: string; hint?: string; value: number; onCommit: (v: string) => void }) {
  return (
    <Row label={label} hint={hint}>
      <CommitInput type="number" value={value} onCommit={onCommit} className="num-input" />
    </Row>
  )
}

function ModelRow({ label, hint, value, onCommit }: { label: string; hint?: string; value: string; onCommit: (v: string) => void }) {
  return (
    <Row label={label} hint={hint}>
      <CommitInput mono value={value} placeholder="(default)" onCommit={(v) => onCommit(v.trim())} />
      <div className="model-chips">
        {MODEL_SUGGESTIONS.map((m) => (
          <button key={m} className={cx('chip', value === m && 'neon')} onClick={() => onCommit(m)}>
            {m.replace('claude-', '')}
          </button>
        ))}
        <button className={cx('chip', !value && 'neon')} onClick={() => onCommit('')}>
          default
        </button>
      </div>
    </Row>
  )
}

function EffortSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">(auto)</option>
      {EFFORTS.map((x) => (
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
  return (
    <>
      <h2 className="sys-title">Dispatch rules</h2>
      <p className="mute">Steer which harness and model handles which mission. First matching rule wins; higher spend priority is tried first among candidates. Your explicit per-mission choice always overrides.</p>
      {s.dispatchRules.length === 0 && <div className="mute side-empty">No rules — every unit uses the Units defaults.</div>}
      {s.dispatchRules.map((r) => (
        <div key={r.id} className="rule panel">
          <div className="rule-head">
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
            <Field label="World">
              <select className="select" value={r.project ?? ''} onChange={(e) => upd(r.id, { project: e.target.value || undefined })}>
                <option value="">Any</option>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
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

function Allies() {
  const allies = useStore((s) => s.snap.allies)
  const projects = useStore((s) => s.snap.projects)
  const [name, setName] = useState('')
  const [scope, setScope] = useState('')
  const [charter, setCharter] = useState('')
  const [worlds, setWorlds] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [retire, setRetire] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const valid = /^[a-z0-9][a-z0-9-]{1,31}$/.test(name) && scope.trim()
  return (
    <>
      <h2 className="sys-title">Allies</h2>
      <p className="mute">Allied Genios with their own base, scope and charter. Genio routes in-scope work to them; they report back through Genio, never to you directly.</p>
      <div className="ally-list">
        {allies.length === 0 && <div className="mute side-empty">No allies recruited.</div>}
        {allies.map((a) => (
          <div key={a.name} className={cx('ally panel', a.retiredAt && 'off')}>
            <Users size={16} className="violet-text" />
            <div className="ally-main">
              <b>{a.name}</b>
              <div className="mute">{a.scope}</div>
              <div className="mono mute" style={{ fontSize: 11 }}>
                {a.projects.join(', ') || 'no worlds'} · {a.model || 'default model'} · since {dateShort(a.createdAt)}
              </div>
            </div>
            {a.retiredAt ? (
              <span className="chip">retired</span>
            ) : (
              <button className="btn sm alert" onClick={() => setRetire(a.name)}>
                Retire
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="label" style={{ margin: '20px 0 10px' }}>
        Recruit an ally
      </div>
      <div className="form-grid">
        <Field label="Name" hint="lowercase, digits, dashes">
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="art-pipeline" />
        </Field>
        <Field label="Model">
          <input className="input mono" value={model} list="ally-models" onChange={(e) => setModel(e.target.value)} placeholder="(default)" />
          <datalist id="ally-models">
            {MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <Field label="Scope" hint="What work routes to this ally" wide>
          <input className="input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Shaders, VFX and the asset import pipeline" />
        </Field>
        <Field label="Charter" wide>
          <textarea className="textarea" rows={3} value={charter} onChange={(e) => setCharter(e.target.value)} placeholder="Standing instructions for this ally" />
        </Field>
        <Field label="Worlds" wide>
          <div className="dep-picker">
            {projects.map((p) => (
              <button key={p.name} className={cx('chip dep', worlds.includes(p.name) && 'neon')} onClick={() => setWorlds((w) => (w.includes(p.name) ? w.filter((x) => x !== p.name) : [...w, p.name]))}>
                {p.name}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <button
        className="btn solid violet"
        style={{ marginTop: 12 }}
        disabled={!valid || busy}
        onClick={async () => {
          setBusy(true)
          const r = await op('Ally recruited', () => api().allyCreate({ name, scope: scope.trim(), charter: charter.trim(), projects: worlds, model: model.trim() || undefined }), (a) => a.name)
          if (r) {
            setName('')
            setScope('')
            setCharter('')
            setWorlds([])
          }
          setBusy(false)
        }}
      >
        <Plus size={13} /> Recruit
      </button>
      {retire && (
        <Confirm
          title={`Retire ${retire}?`}
          tone="alert"
          confirmLabel="Retire"
          body="The ally stops. Genio refuses while it still has units in the field."
          onConfirm={async () => {
            await op('Retire ally', () => api().allyRetire(retire))
          }}
          onClose={() => setRetire(null)}
        />
      )}
    </>
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
      <p className="mute">Fast-forward-only self update of Genio's own checkout. Never touches your worlds. Allies restart on the new build.</p>
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
