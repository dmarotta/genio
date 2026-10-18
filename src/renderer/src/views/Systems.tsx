import { ThisProjectSettings, type ProjectPageId } from './ProjectSettings'
import { PlayerInstanceSettings } from './PlayerInstanceSettings'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Copy, Download, KeyRound, Lock, LockOpen, LogIn, LogOut, Plus, RefreshCw, Search, Trash, Wrench, X } from 'lucide-react'
import type { CategoryPool, DispatchRule, EventSource, HarnessAdapter, PoolCandidate, Project, Settings, ToolStatus, UpdateInfo } from '@shared/types'
import { CATEGORIES, categoryLabel, defaultCategoryPools } from '@shared/dispatch'
import { MAX_UNITS_AT_ONCE } from '@shared/unit-capacity'
import { USAGE_MODES, USAGE_MODE_LABEL, modeSummary, pctText, planLabel, type UsageMode, type UsagePolicyView } from '@shared/usage-mode'
import { SETTINGS_GROUP_LABEL, SETTINGS_PAGES, settingsPage, type SettingsPage, type SettingsPageId } from '@shared/settings-pages'
import { effectiveEngine } from '@shared/engine'
import { supportsUnitySlots } from '@shared/play'
import { REPLY_VOICES } from '@shared/reply-voice'
import { PlanMeter, useUsagePolicyState } from '../components/PlanMeter'
import {
  accountActions, GENIO_CODEX, type AccountStatus, type ApiKeyStatus, type ExplorerStatus, type FalSpend, type SessionCleanupPreview, type SessionCleanupProgress,
  type SessionCleanupResult
} from '@shared/api'
import { PROJECT_WINDOW, api, errText, op, saveSettings, toast, useStore } from '../store'
import { CommitInput, Confirm, Field, Toggle, ViewHeader } from '../components/ui'
import { SettingsTitle } from '../components/SettingsTitle'
import { TerminalView } from '../components/Terminal'
import { Memory } from '../components/Memory'
import { Mailbox } from '../components/Mailbox'
import { EFFORTS } from '../lib/vocab'
import { cx, usd } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { useScreenContext } from '../lib/screen-context'
import { settingAnchor, searchSettings, type SettingsHit } from '@shared/settings-index'
import { joinArgs, splitArgs, type McpServerInput, type McpServerView } from '@shared/mcp'
import { listKey, onSectionRequest, openSettings, readLastPage, rememberPage, requestSystemsSection, takePendingSection, type SettingsRequest } from '../lib/settings-nav'

export { openSettings, requestSystemsSection }
/** Settings pages, in nav order. Kept under its old name for callers that list sections. */
export const SECTIONS = SETTINGS_PAGES
export type Section = SettingsPageId

const isUnity = (p: Project): boolean => supportsUnitySlots(effectiveEngine(p).engine)

/**
 * The pages listed for this window: This project only with a project, Unity slots only for a Unity
 * project, Unity & Play only while a Unity project is registered. The page being shown is always
 * listed, so a deep link never lands on a page missing from the nav.
 */
export function visiblePages(opts: { project?: Project; projects: Project[]; current?: SettingsPageId }): SettingsPage[] {
  return SETTINGS_PAGES.filter((page) => {
    if (page.id === opts.current) return true
    if (page.group === 'project') return !!opts.project && (!page.unity || isUnity(opts.project))
    if (page.unity) return opts.projects.some(isUnity)
    return true
  })
}

/**
 * The page Settings opens on: a deep link's page, else the last page viewed while this window
 * still lists it, else General. The Hub never shows a project page, even when asked for one.
 */
export function startPage(opts: { project?: Project; projects: Project[]; requested?: SettingsPageId; last?: SettingsPageId }): SettingsPageId {
  const fallback: SettingsPageId = opts.project ? 'project' : 'general'
  if (opts.requested) return settingsPage(opts.requested).group === 'project' && !opts.project ? fallback : opts.requested
  const listed = visiblePages({ project: opts.project, projects: opts.projects })
  return opts.last && listed.some((p) => p.id === opts.last) ? opts.last : fallback
}

const typing = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || !!t.closest('.xterm'))

/**
 * The anchor may render a few frames late, then grow as its settings load: keep it aligned
 * for a moment unless the player scrolls or clicks first. Gives up after about a second.
 */
function revealAnchor(id: string): () => void {
  let frame = 0
  let tries = 60
  let stop = (): void => undefined
  const seek = (): void => {
    const el = document.getElementById(id)
    if (!el) {
      if (--tries > 0) frame = requestAnimationFrame(seek)
      return
    }
    // Collapsed parts open so the target is visible.
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true
    const align = (): void => el.scrollIntoView({ block: 'start' })
    align()
    el.focus({ preventScroll: true })
    // A brief highlight shows which row a link or search result meant.
    el.classList.add('sys-hit')
    setTimeout(() => el.classList.remove('sys-hit'), 1600)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(align)
    ro.observe(el)
    // Sections above the anchor may finish loading later and push it down.
    if (el.parentElement) ro.observe(el.parentElement)
    const timer = setTimeout(() => stop(), 1500)
    stop = () => { ro.disconnect(); clearTimeout(timer); for (const e of ['wheel', 'pointerdown', 'keydown']) window.removeEventListener(e, stop) }
    for (const e of ['wheel', 'pointerdown', 'keydown']) window.addEventListener(e, stop)
  }
  frame = requestAnimationFrame(seek)
  return () => { cancelAnimationFrame(frame); stop() }
}

export function Systems() {
  const settings = useStore((s) => s.settings)
  const projects = useStore((s) => s.snap.projects)
  const project = projects.find((p) => p.name === PROJECT_WINDOW)
  const [request, setRequest] = useState<SettingsRequest | null>(takePendingSection)
  const [sec, setSecState] = useState<SettingsPageId>(() => startPage({ project, projects, requested: request?.page, last: readLastPage() }))
  const [sheet, setSheet] = useState(false)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const [focused, setFocused] = useState<SettingsPageId | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLButtonElement>(null)
  const links = useRef<(HTMLButtonElement | null)[]>([])
  const setSec = (id: SettingsPageId): void => { setSecState(id); setSheet(false) }
  useEffect(() => onSectionRequest((r) => {
    const page = startPage({ project, projects, requested: r.page })
    setSec(page)
    setRequest(page === r.page ? r : { page })
  }), [project, projects])
  useEffect(() => (request?.anchor && settings ? revealAnchor(request.anchor) : undefined), [request, !!settings])
  useEffect(() => rememberPage(sec), [sec])
  // Ctrl+F, or / outside a field, focuses the search box (opening the picker sheet at narrow widths).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const find = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f'
      if (!find && !(e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target))) return
      e.preventDefault()
      setSheet(true)
      search.current?.focus()
      search.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const page = settingsPage(sec)
  useScreenContext('systems', { facts: [{ label: 'Section', value: `${page.group === 'project' ? 'This project' : SETTINGS_GROUP_LABEL[page.group]} › ${page.label}` }] })
  // This window's rules apply to search too: no project pages in the Hub.
  const searchable = visiblePages({ project, projects })
  const hits = searchSettings(query, (id) => searchable.some((p) => p.id === id))
  if (!settings) return <div className="view"><div className="bar indeterminate"><i /></div></div>

  const visible = visiblePages({ project, projects, current: sec })
  const openHit = (h: SettingsHit | undefined): void => {
    if (!h) return
    setSec(h.page)
    setRequest({ page: h.page, anchor: h.anchor })
    setQuery('')
    setHit(0)
  }
  const searchKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      if (query) { e.stopPropagation(); setQuery(''); setHit(0) }
      return
    }
    if (e.key === 'Enter') { e.preventDefault(); openHit(hits[hit]); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    if (query) setHit(listKey(e.key, hit, hits.length) ?? 0)
    else if (e.key === 'ArrowDown') links.current[Math.max(0, visible.findIndex((p) => p.id === sec))]?.focus()
  }
  const linkKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number): void => {
    const to = listKey(e.key, i, visible.length)
    if (to === null) return
    e.preventDefault()
    if (e.key === 'ArrowUp' && i === 0) search.current?.focus()
    else links.current[to]?.focus()
  }
  const tabStop = focused && visible.some((p) => p.id === focused) ? focused : sec
  let lastGroup = ''
  return (
    <div className="view sys-view">
      <ViewHeader
        title={
          <>
            <span className="accent">Settings</span>
          </>
        }
      />
      <div className={cx('sys-layout', sheet && 'sheet-open')}>
        <nav className="sys-nav" aria-label="Settings pages">
          <button
            ref={picker}
            className="sys-picker"
            aria-expanded={sheet}
            aria-controls="sys-nav-list"
            onClick={() => {
              setSheet(!sheet)
              if (!sheet) setTimeout(() => search.current?.focus(), 0)
            }}
          >
            <span className="sys-picker-scope">{SETTINGS_GROUP_LABEL[page.group]} ›</span> <b>{page.label}</b>
            <ChevronDown size={14} />
          </button>
          <div
            id="sys-nav-list"
            className="sys-nav-list"
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !sheet) return
              setSheet(false)
              picker.current?.focus()
            }}
          >
            <div className="sys-search">
              <Search size={13} className="mute" />
              <input
                ref={search}
                className="input"
                type="search"
                role="combobox"
                aria-label="Search settings"
                aria-expanded={!!query}
                aria-controls="sys-results"
                aria-activedescendant={query && hits[hit] ? `sys-result-${hit}` : undefined}
                aria-keyshortcuts="Control+F /"
                placeholder="Search settings"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setHit(0) }}
                onKeyDown={searchKey}
              />
            </div>
            {query ? (
              <div id="sys-results" className="sys-results" role="listbox" aria-label="Matching settings">
                {hits.map((h, i) => (
                  <button
                    key={`${h.page}:${h.label}`}
                    id={`sys-result-${i}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === hit}
                    className={cx('sys-result', i === hit && 'on')}
                    onMouseEnter={() => setHit(i)}
                    onClick={() => openHit(h)}
                  >
                    <span className="sys-result-label">{h.label}</span>
                    <span className="sys-result-meta">
                      <span className={cx('chip', 'sys-chip', `sys-chip-${settingsPage(h.page).group}`)}>{h.scope}</span>
                      {h.anchor && <span className="sys-result-path mute">{settingsPage(h.page).label}</span>}
                    </span>
                  </button>
                ))}
                {!hits.length && <div className="mute sys-noresult">No settings match “{query}”.</div>}
              </div>
            ) : (
              visible.map((s, i) => {
                const head = s.group !== lastGroup
                lastGroup = s.group
                return (
                  <div key={s.id} className={cx('sys-nav-item', `sys-in-${s.group}`)}>
                    {head && <div className="label sys-group">{SETTINGS_GROUP_LABEL[s.group]}</div>}
                    <button
                      ref={(el) => { links.current[i] = el }}
                      className={cx('sys-link', sec === s.id && 'on')}
                      aria-current={sec === s.id ? 'page' : undefined}
                      tabIndex={s.id === tabStop ? 0 : -1}
                      onFocus={() => setFocused(s.id)}
                      onKeyDown={(e) => linkKey(e, i)}
                      onClick={() => setSec(s.id)}
                    >
                      {s.label}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </nav>
        <div className="sys-body panel">
          <SectionBody sec={sec} s={settings} />
        </div>
      </div>
    </div>
  )
}

/** A setting row; its id comes from the label so search and deep links can reveal it. */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="sys-row" id={settingAnchor(label)} tabIndex={-1}>
      <div className="sys-row-label">
        <div className="sys-row-title">{label}</div>
        {hint && <div className="mute sys-row-hint">{hint}</div>}
      </div>
      <div className="sys-row-ctl">{children}</div>
    </div>
  )
}

/** A titled part of a page; with an id it is a deep-link anchor (old pages that merged into this one). */
function Part({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className="sys-part" aria-label={title}>
      <h3 className="sys-subtitle">{title}</h3>
      {children}
    </section>
  )
}

const set = (patch: Partial<Settings>): void => void saveSettings(patch)
const num = (v: string, min = 0): number => Math.max(min, Number(v) || 0)

function SectionBody({ sec, s }: { sec: SettingsPageId; s: Settings }) {
  switch (sec) {
    case 'project':
    case 'project-delivery':
    case 'project-assets':
    case 'project-unity':
      return <ThisProjectSettings page={sec as ProjectPageId} />
    case 'general':
      return (
        <>
          <SettingsTitle page="general" />
          <Row label="Gamertag">
            <CommitInput value={s.gamertag} onCommit={(v) => set({ gamertag: v.trim() || 'Player' })} />
          </Row>
          <Row label="Read replies aloud" hint="Genio speaks its chat replies with a voice that runs on this PC.">
            <Toggle checked={s.voice} onChange={(v) => set({ voice: v })} />
          </Row>
          {s.voice && <ReplyVoiceRow value={s.replyVoice} />}
          <Row label="Scanlines and grid">
            <Toggle
              checked={s.fx}
              onChange={(v) => {
                document.body.classList.toggle('fx-off', !v)
                set({ fx: v })
              }}
            />
          </Row>
          <Row label="Clean chat">
            <Toggle checked={s.calm} onChange={(v) => set({ calm: v })} />
          </Row>
          <Row label="Desktop notifications">
            <Toggle checked={s.desktopNotifications} onChange={(v) => set({ desktopNotifications: v })} />
          </Row>
          <Row label="Feature tips">
            <Toggle ariaLabel="Feature tips" checked={s.featureTips} onChange={(v) => set({ featureTips: v })} />
          </Row>
          <Row label="Sounds">
            <Toggle checked={s.sound} onChange={(v) => set({ sound: v })} />
          </Row>
          {s.sound && (
            <Row label="Volume">
              <input
                type="range"
                className="range"
                aria-label="Volume"
                min={0}
                max={1}
                step={0.05}
                value={s.soundVolume}
                onChange={(e) => set({ soundVolume: Number(e.target.value) })}
                onMouseUp={() => playSfx('ready', { ...s, sound: true })}
              />
            </Row>
          )}
          <Part id="settings-away" title="While you're away">
            <Row label="Send away alerts to">
              <select className="select" aria-label="Webhook kind" value={s.webhookKind} onChange={(e) => set({ webhookKind: e.target.value as Settings['webhookKind'] })}>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
                <option value="generic">Any JSON webhook</option>
              </select>
              <CommitInput mono value={s.webhookUrl} placeholder="https://discord.com/api/webhooks/…" onCommit={(v) => set({ webhookUrl: v.trim() })} />
            </Row>
            <AlarmRow value={s.alarm} />
          </Part>
        </>
      )
    case 'usage':
      return <Usage s={s} />
    case 'accounts':
      return <Accounts />
    case 'memory':
      return <Memory budget={s.memoryBudgetTokens} />
    case 'units':
      return (
        <>
          <SettingsTitle page="units" />
          <Row label="Default agent tool">
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
          <Row label="Claude unit permissions">
            <select className="select" value={s.claudePermissionMode} onChange={(e) => set({ claudePermissionMode: e.target.value as Settings['claudePermissionMode'] })}>
              <option value="bypass">Run any command in its copy (fastest)</option>
              <option value="auto">Let a safety check decide</option>
              <option value="acceptEdits">Ask before commands</option>
            </select>
          </Row>
          <Row label="Start queued quests automatically">
            <Toggle checked={s.autoDispatchQueued} onChange={(v) => set({ autoDispatchQueued: v })} />
          </Row>
          <Row label="Remove AI co-author lines">
            <Toggle checked={s.stripAiTrailers} onChange={(v) => set({ stripAiTrailers: v })} />
          </Row>
          <Row label="Credit Genio as co-author">
            <Toggle checked={s.genioCoAuthor} onChange={(v) => set({ genioCoAuthor: v })} />
          </Row>
          <div className="sys-row col" id={settingAnchor('Instructions for every unit')} tabIndex={-1}>
            <div className="sys-row-title">Instructions for every unit</div>
            <BriefInclude value={s.briefInclude} />
          </div>
        </>
      )
    case 'play':
      return <UnityAndPlay />
    case 'inbox':
      return <Inbox s={s} />
    case 'system':
      return <SystemPage />
    case 'dispatch':
      return <Dispatch s={s} />
    case 'harnesses':
      return <Harnesses s={s} />
  }
}

/** Genio › Unity & Play: the player's own Play editor, stored once for every Unity project. */
function UnityAndPlay() {
  const projects = useStore((s) => s.snap.projects)
  const own = projects.find((p) => p.name === PROJECT_WINDOW && isUnity(p))
  const world = own ?? projects.find(isUnity)
  return (
    <>
      <SettingsTitle page="play" />
      {world
        ? <PlayerInstanceSettings key={world.name} world={world.name} />
        : <p className="mute">Register a Unity project to use Play.</p>}
    </>
  )
}

/** Genio › System: tools on this PC, Windows integration, updates and Genio's past sessions in the Codex and Claude apps. */
function SystemPage() {
  return (
    <>
      <SettingsTitle page="system" />
      <Toolchain />
      <ExplorerIntegration />
      <Patch />
      <Housekeeping />
    </>
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
  return <Part id="settings-explorer" title="Windows integration">
    <Row label="Open with Genio">
      <button className="btn sm" disabled={busy || state?.available === false || state?.installed === true} onClick={() => void change(true)}>Install</button>
      <button className="btn sm" disabled={busy || state?.available === false} onClick={() => void change(false)}>Remove</button>
    </Row>
    {!busy && state?.available === false && <p className="mute">Available on Windows only.</p>}
    {!busy && state?.available !== false && !state?.installed && state?.present && <p className="mute">A partial or older installation exists. Install to update it, or Remove to clean it up.</p>}
    {error && <p role="alert">{error}</p>}
  </Part>
}

const LEVEL_TEXT = { ok: 'below 70%: the mode as set', warm: '70-84%: exploration off, one unit, Auto effort one step lower, other plan preferred', hot: '85-94%: no automatic units; Auto chat Sonnet / low', out: '95%+ or rejected: no new automatic work until reset' } as const

/**
 * Settings › Usage & limits: one mode, protection while it is acting, the shared plan meter (its only
 * full home), paid OpenRouter spend, and whatever is pinned, each with a way to undo it.
 */
function Usage({ s }: { s: Settings }) {
  const { view, error: usageError } = useUsagePolicyState()
  const mode: UsageMode = s.usageMode ?? 'balanced'
  const [hover, setHover] = useState<UsageMode | null>(null)
  const pins = pinnedOverrides(s, view)
  const acting = s.quotaProtection !== false ? view?.plans.filter((p) => p.level !== 'ok') ?? [] : []
  return (
    <>
      <SettingsTitle page="usage" />
      <div className="usage-mode-bar" id="settings-usage-mode" tabIndex={-1}>
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
            </button>
          ))}
        </div>
      </div>
      <div className="usage-summary">
        <b>{modeSummary(hover ?? mode, view?.chat)}</b>
      </div>
      <Row label="Units at once">
        <select className="select" aria-label="Units at once" value={s.unitsAtOnce} onChange={(e) => set({ unitsAtOnce: Number(e.target.value) })}>
          {Array.from({ length: MAX_UNITS_AT_ONCE }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </Row>

      {acting.length > 0 && (
        <div className="usage-levels">
          {acting.map((p) => (
            <div key={p.plan} className={cx('usage-level', `lvl-${p.level}`)}>
              <b>{planLabel(p.plan)}</b>
              <span className="mono">{pctText(p)}</span>
              <span className="mute">{LEVEL_TEXT[p.level]}</span>
            </div>
          ))}
        </div>
      )}
      {s.quotaProtection !== false && view && view.waiting.length > 0 && (
        <div className="amber-text" style={{ marginTop: 8 }}>
          {view.waiting.length} queued quest{view.waiting.length === 1 ? '' : 's'} wait{view.waiting.length === 1 ? 's' : ''} for a plan reset (see Quests).
        </div>
      )}

      <div className="label" style={{ margin: '18px 0 6px' }}>Plan remaining</div>
      <PlanMeter view={view} error={usageError} />
      <Row label="Quota protection" hint="Slow automatic work as plans fill up; provider limits always apply.">
        <Toggle ariaLabel="Quota protection" checked={s.quotaProtection !== false} onChange={(v) => set({ quotaProtection: v })} />
      </Row>

      <Row label="Allow paid OpenRouter spend">
        <Toggle checked={!!s.cheapSpendAllowed} onChange={(v) => set({ cheapSpendAllowed: v })} />
        {view && s.cheapSpendAllowed && !view.cheap.allowed && <span className="mute">{view.cheap.why}</span>}
        {view && s.cheapSpendAllowed && /OpenRouter key/.test(view.cheap.why) && (
          <button className="link-btn" onClick={() => requestSystemsSection('accounts', 'settings-api-keys')}>Add the key in Accounts &amp; keys →</button>
        )}
      </Row>

      {pins.length > 0 && (
        <>
          <div className="label" style={{ margin: '18px 0 6px' }}>Pinned</div>
          <div className="usage-pins">
            {pins.map((p) => (
              <div key={p.label} className="usage-pin">
                <span>{p.label}</span>
                <span className="mono">{p.value}</span>
                {p.unpin ? (
                  <button className="btn sm ghost" onClick={p.unpin}>Unpin</button>
                ) : (
                  <button className="btn sm ghost" onClick={() => requestSystemsSection('dispatch')}>Open</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

interface Pin {
  label: string
  value: string
  unpin?: () => void
}

/** Choices that override the mode: kept so a pin set earlier (or by a project) can still be seen and undone. */
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

/** The voice that reads replies, under Read replies aloud: shown only once the natural voice is downloaded. */
function ReplyVoiceRow({ value }: { value: Settings['replyVoice'] }) {
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    let alive = true
    void api().voiceOutputStatus().then((st) => { if (alive) setInstalled(st.state === 'ready') }).catch(() => undefined)
    const off = window.genio?.on?.((e) => { if (e.type === 'voice-output-install') setInstalled(e.state === 'ready') })
    return () => { alive = false; off?.() }
  }, [])
  if (!installed) return null
  return (
    <Row label="Voice">
      <select className="select" aria-label="Voice" value={value} onChange={(e) => set({ replyVoice: e.target.value as Settings['replyVoice'] })}>
        {REPLY_VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </select>
    </Row>
  )
}

/** The stored alarm string stays 'off' | 'auto' | 'command:<cmd>'; the row shows it as a choice plus a command box. */
export function AlarmRow({ value }: { value: string }) {
  const stored = (value || 'auto').trim()
  const command = stored.startsWith('command:') ? stored.slice('command:'.length).trim() : null
  const [kind, setKind] = useState<'off' | 'auto' | 'command'>(command !== null ? 'command' : stored === 'off' ? 'off' : 'auto')
  useEffect(() => setKind(command !== null ? 'command' : stored === 'off' ? 'off' : 'auto'), [stored])
  return (
    <Row label="If you don't respond">
      <div className="alarm-ctl">
        <select
          className="select"
          aria-label="Alarm"
          value={kind}
          onChange={(e) => {
            const next = e.target.value as typeof kind
            setKind(next)
            // A command is saved once it is typed; switching back keeps nothing half-set.
            if (next !== 'command') set({ alarm: next })
            else if (command) set({ alarm: `command:${command}` })
          }}
        >
          <option value="off">Off</option>
          <option value="auto">Desktop + sound</option>
          <option value="command">Run a command</option>
        </select>
        {kind === 'command' && (
          <CommitInput mono value={command ?? ''} placeholder="e.g. C:\scripts\notify.cmd" onCommit={(v) => set({ alarm: v.trim() ? `command:${v.trim()}` : 'auto' })} />
        )}
      </div>
    </Row>
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

/** Settings › Inbox & automation: notes from scripts and your phone (HTTP intake) and scheduled checks. */
function Inbox({ s }: { s: Settings }) {
  return (
    <>
      <SettingsTitle page="inbox" />
      <Row label="Accept notes from scripts and your phone">
        <Toggle checked={s.inboxServer} onChange={(v) => set({ inboxServer: v })} />
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
      <Mailbox />
      <Triggers s={s} />
    </>
  )
}

/** Advanced › Agent tools: which coding-agent CLIs units may run, the terminal shell, and MCP servers. */
function Harnesses({ s }: { s: Settings }) {
  const save = (list: HarnessAdapter[]): void => set({ harnesses: list })
  const upd = (id: string, patch: Partial<HarnessAdapter>): void => save(s.harnesses.map((h) => (h.id === id ? { ...h, ...patch } : h)))
  return (
    <>
      <SettingsTitle page="harnesses" />
      <Row label="Terminal shell">
        <CommitInput mono value={s.shell} placeholder="powershell" onCommit={(v) => set({ shell: v.trim() })} />
      </Row>
      <div className="harness-list">
        {s.harnesses.map((h) => (
          <div key={h.id} className={cx('harness panel', !h.enabled && 'off')}>
            <div className="harness-head">
              <Toggle checked={h.enabled} onChange={(v) => upd(h.id, { enabled: v })} />
              <b>{h.name}</b>
              <span style={{ flex: 1 }} />
              {!h.builtin && (
                <button className="btn sm ghost icon alert" title={`Remove ${h.name}`} aria-label={`Remove ${h.name}`} onClick={() => save(s.harnesses.filter((x) => x.id !== h.id))}>
                  <Trash size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <McpServers />
    </>
  )
}

interface McpDraft { id?: string; name: string; remote: boolean; command: string; args: string; url: string; project: string; chatOnly: boolean; secrets: { name: string; value: string; set: boolean }[] }

const mcpDraft = (s?: McpServerView): McpDraft => ({
  id: s?.id, name: s?.name ?? '', remote: Boolean(s?.url), command: s?.command ?? '', args: joinArgs(s?.args ?? []), url: s?.url ?? '',
  project: s?.project ?? '', chatOnly: Boolean(s?.chatOnly), secrets: (s?.secrets ?? []).map((n) => ({ name: n, value: '', set: Boolean(s?.secretSet[n]) }))
})

/** Agent tools › MCP servers: the only place a server is added. Secret values go to the OS-encrypted store and never come back. */
function McpServers() {
  const projects = useStore((st) => st.snap.projects)
  const [list, setList] = useState<McpServerView[]>([])
  const [draft, setDraft] = useState<McpDraft | null>(null)
  const [remove, setRemove] = useState<McpServerView | null>(null)
  useEffect(() => { void api().mcpServers().then(setList).catch(() => setList([])) }, [])
  const edit = (patch: Partial<McpDraft>): void => setDraft((d) => (d ? { ...d, ...patch } : d))
  const secret = (i: number, patch: Partial<McpDraft['secrets'][number]>): void =>
    edit({ secrets: draft!.secrets.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  const save = async (): Promise<void> => {
    if (!draft) return
    const d = draft
    const input: McpServerInput = {
      id: d.id, name: d.name.trim(), project: d.project || undefined, chatOnly: d.chatOnly || undefined,
      ...(d.remote ? { url: d.url.trim() } : { command: d.command.trim(), args: splitArgs(d.args) }),
      secrets: d.secrets.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), value: x.value || undefined }))
    }
    try {
      setList(await api().mcpServerSave(input))
      setDraft(null)
    } catch (e) {
      toast('error', 'MCP server', errText(e))
    }
  }
  // The browser does the sign-in; the list turns Sign in into Sign out when it ends.
  const signIn = async (id: string): Promise<void> => {
    try { setList(await api().mcpServerSignIn(id)) } catch (e) { toast('error', 'MCP server', errText(e)) }
  }
  const signOut = async (id: string): Promise<void> => {
    try { setList(await api().mcpServerSignOut(id)) } catch (e) { toast('error', 'MCP server', errText(e)) }
  }
  const form = (d: McpDraft): ReactNode => (
    <div key={d.id ?? 'new'} className="harness panel mcp-server">
      <div className="harness-fields">
        <Field label="Name">
          <input className="input mono" value={d.name} placeholder="linear" onChange={(e) => edit({ name: e.target.value.toLowerCase() })} />
        </Field>
        <Field label="Runs">
          <select className="select" value={d.remote ? 'url' : 'command'} onChange={(e) => edit({ remote: e.target.value === 'url', secrets: [] })}>
            <option value="command">On this PC (command)</option>
            <option value="url">Remote (URL)</option>
          </select>
        </Field>
        {d.remote ? (
          <Field label="URL" wide>
            <input className="input mono" value={d.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => edit({ url: e.target.value })} />
          </Field>
        ) : (
          <>
            <Field label="Command">
              <input className="input mono" value={d.command} placeholder="npx" onChange={(e) => edit({ command: e.target.value })} />
            </Field>
            <Field label="Arguments">
              <input className="input mono" value={d.args} onChange={(e) => edit({ args: e.target.value })} />
            </Field>
          </>
        )}
        <Field label="Projects">
          <select className="select" value={d.project} onChange={(e) => edit({ project: e.target.value })}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Used by">
          <select className="select" value={d.chatOnly ? 'chat' : 'all'} onChange={(e) => edit({ chatOnly: e.target.value === 'chat' })}>
            <option value="all">Units and chat</option>
            <option value="chat">Chat only</option>
          </select>
        </Field>
      </div>
      <div className="label" style={{ margin: '12px 0 6px' }}>{d.remote ? 'Secret headers' : 'Secret environment variables'}</div>
      {d.secrets.map((x, i) => (
        <div key={i} className="row mcp-secret">
          <input className="input mono" aria-label="Secret name" value={x.name} placeholder={d.remote ? 'Authorization' : 'API_TOKEN'} onChange={(e) => secret(i, { name: e.target.value, set: false })} />
          <input className="input mono" aria-label="Secret value" type="password" autoComplete="off" spellCheck={false} value={x.value}
            placeholder={x.set ? '•••••••• stored' : 'Value'} onChange={(e) => secret(i, { value: e.target.value })} />
          <button className="btn sm ghost icon" title="Remove secret" aria-label="Remove secret" onClick={() => edit({ secrets: d.secrets.filter((_, j) => j !== i) })}>
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm ghost" onClick={() => edit({ secrets: [...d.secrets, { name: '', value: '', set: false }] })}>
          <KeyRound size={12} /> Add secret
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn sm ghost" onClick={() => setDraft(null)}>Cancel</button>
        <button className="btn sm solid" disabled={!d.name.trim() || !(d.remote ? d.url.trim() : d.command.trim())} onClick={() => void save()}>Save</button>
      </div>
    </div>
  )
  return (
    <Part id="settings-mcp" title="MCP servers">
      <div className="harness-list">
        {list.map((s) => (draft?.id === s.id ? form(draft) : (
          <div key={s.id} className="harness panel mcp-server">
            <div className="harness-head">
              <b className="mono">{s.name}</b>
              <span className="mono mute mcp-target">{s.url ?? [s.command, joinArgs(s.args ?? [])].filter(Boolean).join(' ')}</span>
              <span style={{ flex: 1 }} />
              <span className="mute mcp-scope">{s.project ?? 'All projects'}{s.chatOnly && ' · Chat only'}</span>
              {s.signIn && (s.signedIn
                ? <button className="btn sm ghost" onClick={() => void signOut(s.id)}>Sign out</button>
                : <button className="btn sm" onClick={() => void signIn(s.id)}>Sign in</button>)}
              <button className="btn sm ghost" disabled={!!draft} onClick={() => setDraft(mcpDraft(s))}>Edit</button>
              <button className="btn sm ghost icon alert" title={`Remove ${s.name}`} aria-label={`Remove ${s.name}`} onClick={() => setRemove(s)}>
                <Trash size={12} />
              </button>
            </div>
          </div>
        )))}
        {draft && !draft.id && form(draft)}
      </div>
      {!draft && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => setDraft(mcpDraft())}>
            <Plus size={13} /> Add server
          </button>
        </div>
      )}
      {remove && (
        <Confirm
          title={`Remove ${remove.name}?`}
          tone="alert"
          confirmLabel="Remove"
          body="Its stored secrets are deleted. Units lose its tools at once."
          onConfirm={async () => {
            try { setList(await api().mcpServerRemove(remove.id)) } catch (e) { toast('error', 'MCP server', errText(e)) }
          }}
          onClose={() => setRemove(null)}
        />
      )}
    </Part>
  )
}

function Dispatch({ s }: { s: Settings }) {
  const projects = useStore((st) => st.snap.projects)
  const save = (rules: DispatchRule[]): void => set({ dispatchRules: rules })
  const upd = (id: string, patch: Partial<DispatchRule>): void => save(s.dispatchRules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const harnessOpts = s.harnesses.filter((h) => h.enabled)
  return (
    <>
      <SettingsTitle page="dispatch" />
      <Row label="Learn the order automatically">
        <Toggle checked={s.autoReorder} onChange={(v) => set({ autoReorder: v })} />
      </Row>

      <CategoryTable s={s} />

      <div className="label" style={{ margin: '22px 0 8px' }}>
        Rules
      </div>
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
                {/* Rules are global; a window lists only its own project, so keep another project's scope visible. */}
                {[...new Set([...projects.map((p) => p.name), ...(r.project ? [r.project] : [])])].map((name) => (
                  <option key={name} value={name}>
                    {name}
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

function CategoryTable({ s }: { s: Settings }) {
  const harnessOpts = s.harnesses.filter((h) => h.enabled)
  const [reset, setReset] = useState(false)
  const savePools = (pools: CategoryPool[]): void => set({ categoryPools: pools })
  const updPool = (cat: string, patch: Partial<CategoryPool>): void => savePools(s.categoryPools.map((p) => (p.category === cat ? { ...p, ...patch } : p)))
  return (
    <>
      <div className="label" style={{ margin: '22px 0 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
        Category table
        <button className="btn sm ghost" onClick={() => setReset(true)}>
          <RefreshCw size={11} /> Reset to defaults
        </button>
      </div>
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
                return (
                  <div key={i} className="cand-row cat-cand">
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

function Triggers({ s }: { s: Settings }) {
  const save = (list: EventSource[]): void => set({ eventSources: list })
  const upd = (id: string, patch: Partial<EventSource>): void => save(s.eventSources.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  return (
    <Part id="settings-triggers" title="Scheduled checks">
      {s.eventSources.map((e) => (
        <div key={e.id} className="rule panel">
          <div className="rule-head">
            <Toggle checked={e.enabled} onChange={(v) => upd(e.id, { enabled: v })} />
            <Field label="Name">
              <CommitInput value={e.name} onCommit={(v) => upd(e.id, { name: v })} />
            </Field>
            <Field label="Every (seconds)">
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
              <CommitInput mono value={e.command} placeholder="e.g. git log -1 --format=%cd" onCommit={(v) => upd(e.id, { command: v })} />
            </Field>
            <Field label="Run in folder">
              <CommitInput mono value={e.cwd ?? ''} placeholder="(base)" onCommit={(v) => upd(e.id, { cwd: v.trim() || undefined })} />
            </Field>
            {e.trigger === 'match' && (
              <Field label="Pattern (regex)">
                <CommitInput mono value={e.pattern ?? ''} placeholder="e.g. FAILED|error" onCommit={(v) => upd(e.id, { pattern: v })} />
              </Field>
            )}
          </div>
        </div>
      ))}
      <button
        className="btn"
        onClick={() => save([...s.eventSources, { id: `trig-${Date.now().toString(36)}`, name: 'New trigger', command: '', intervalSec: 300, trigger: 'nonzero', enabled: false }])}
      >
        <Plus size={13} /> Add trigger
      </button>
    </Part>
  )
}

function Toolchain() {
  const [tools, setTools] = useState<ToolStatus[] | null>(null)
  const [confirm, setConfirm] = useState<ToolStatus | null>(null)
  const load = (): void => {
    setTools(null)
    void api().toolchain().then(setTools).catch((e) => {
      toast('error', 'Could not check installed tools', errText(e))
      setTools([])
    })
  }
  useEffect(load, [])
  return (
    <Part id="settings-tools" title="Installed tools">
      <button className="btn sm ghost" onClick={load}>
        <RefreshCw size={12} /> Rescan
      </button>
      {!tools && (
        <div className="bar indeterminate">
          <i />
        </div>
      )}
      <div className="tool-list">
        {tools?.map((t) => (
          <div key={t.name} className="tool-row">
            <b className="mono">{t.name}</b>
            <span className="mute tool-purpose">{t.purpose}</span>
            <span className={cx('mono', t.required ? 'alert-text' : 'mute')}>{t.found ? '' : t.required ? 'missing · required' : 'missing'}</span>
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
    </Part>
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
  const [fal, setFal] = useState<FalSpend | undefined>()
  const sessionTerm = useStore((s) => (session ? s.terminals[session] : undefined))
  // read on opening the screen and on Refresh only: no background polling
  const load = (): void => {
    setAccounts(null)
    void api().accounts().then(setAccounts).catch((e) => {
      toast('error', 'Account check failed', errText(e))
      setAccounts([])
    })
    void api().apiKeys().then(setKeys).catch(() => setKeys([]))
    void api().accountUsage().then((u) => setFal(u.fal)).catch(() => undefined)
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
      <SettingsTitle page="accounts">
        <button className="btn sm ghost" style={{ marginLeft: 12 }} onClick={load}>
          <RefreshCw size={12} /> Refresh
        </button>
      </SettingsTitle>
      {!accounts && (
        <div className="bar indeterminate">
          <i />
        </div>
      )}
      <div className="tool-list account-list">
        {accounts?.map((a) => {
          const st = LOGIN_LABEL[a.state]
          const actions = accountActions(a)
          const detail = a.detail ?? a.note
          return (
            <div key={a.tool} className="tool-row account-row">
              <div className="account-main">
                <div>{a.label}</div>
                {a.installed ? (
                  <>
                    {detail && <div className="mute tool-purpose">{detail}</div>}
                    {a.warning && <div className="tool-purpose account-warning">{a.warning}</div>}
                  </>
                ) : (
                  <div className="mute tool-purpose">
                    not installed{a.install && <> · <span className="mono selectable">{a.install}</span></>}
                  </div>
                )}
              </div>
              {a.installed ? <span className={cx('chip', a.stateLabel === 'error' ? 'alert' : st.tone)}>{a.stateLabel ?? st.text}</span> : <span />}
              <div className="row account-actions">
                {actions.login && (
                  <button className="btn sm" onClick={() => void start(a, 'login')}>
                    <LogIn size={12} /> {a.loginLabel ?? 'Log in'}
                  </button>
                )}
                {actions.logout && (
                  <button className="btn sm ghost" onClick={() => setLogout(a)}>
                    <LogOut size={12} /> {a.logoutLabel ?? 'Log out'}
                  </button>
                )}
              </div>
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
      <div className="label" id="settings-api-keys" tabIndex={-1} style={{ margin: '22px 0 8px' }}>
        API keys
      </div>
      {keys.map((k) => (
        <ApiKeyRow key={k.id} k={k} spend={k.id === 'fal' ? fal : undefined} onChange={() => void api().apiKeys().then(setKeys).catch(() => undefined)} />
      ))}
      {logout && (
        <Confirm
          title={logout.tool === GENIO_CODEX ? `Sign out ${logout.label}?` : `Log out of ${logout.label}?`}
          tone="amber"
          confirmLabel={logout.logoutLabel ?? 'Log out'}
          body={logout.tool === GENIO_CODEX
            ? "Signs out only Genio's own Codex home; your own Codex login is untouched. Codex units and chats go back to your normal Codex home, where they can show in your Codex app."
            : `Runs ${logout.tool}'s own logout. Units using ${logout.label} will need you to log in again.`}
          onConfirm={() => start(logout, 'logout')}
          onClose={() => setLogout(null)}
        />
      )}
    </>
  )
}

/** System › Genio's past sessions (once Advanced › Maintenance): hide them from the player's Codex and Claude apps, on a click, with Undo. */
function Housekeeping() {
  const [preview, setPreview] = useState<SessionCleanupPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<SessionCleanupProgress | null>(null)
  const [result, setResult] = useState<SessionCleanupResult | null>(null)
  const [confirm, setConfirm] = useState<'hide' | 'undo' | null>(null)
  const load = async (): Promise<void> => {
    setLoading(true)
    try { setPreview(await api().sessionCleanupPreview()) }
    catch (e) { toast('error', 'Could not look for past sessions', errText(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    void api().sessionCleanupProgress().then(p => { if (p.running) setProgress(p) }).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!progress?.running) return
    const timer = setInterval(() => void api().sessionCleanupProgress().then(setProgress).catch(() => undefined), 400)
    return () => clearInterval(timer)
  }, [progress?.running])
  const go = async (action: 'hide' | 'undo'): Promise<void> => {
    setResult(null)
    setProgress({ running: true, action, step: 'Starting', done: 0, total: 0 })
    try {
      const keys = [...(preview?.codex ?? []), ...(preview?.claude ?? [])].map((i) => i.key)
      const r = action === 'hide' ? await api().sessionCleanupRun(keys) : await api().sessionCleanupUndo()
      setResult(r)
    } catch (e) {
      toast('error', action === 'hide' ? 'Could not hide past sessions' : 'Could not restore past sessions', errText(e))
    } finally {
      setProgress(null)
      await load()
    }
  }
  const count = (preview?.codex.length ?? 0) + (preview?.claude.length ?? 0)
  const running = !!progress?.running
  return (
    <Part id="settings-maintenance" title="Genio's past sessions">
      <Row label="Hide them from the Codex and Claude apps">
        <button className="btn sm" disabled={loading || running} onClick={() => void load()}>
          {preview ? <RefreshCw size={12} /> : null} {preview ? 'Look again' : 'Preview'}
        </button>
      </Row>
      {loading && (
        <div className="bar indeterminate">
          <i />
        </div>
      )}
      {preview && !running && (
        <div className="mute" style={{ margin: '4px 0 8px' }}>
          {count
            ? `${preview.codex.length} Codex thread${preview.codex.length === 1 ? '' : 's'} to archive · ${preview.claude.length} Claude folder${preview.claude.length === 1 ? '' : 's'} to move`
            : 'Nothing of Genio\'s left in your Codex or Claude apps.'}
          {preview.skipped.length > 0 && ` · ${preview.skipped.length} left alone (running now)`}
        </div>
      )}
      {running && progress && (
        <div style={{ margin: '4px 0 8px' }}>
          <div className="mute">{progress.step}{progress.total ? ` · ${progress.done}/${progress.total}` : ''}</div>
          <div className={cx('bar', !progress.total && 'indeterminate')}>
            <i style={progress.total ? { width: `${Math.round((progress.done / progress.total) * 100)}%` } : undefined} />
          </div>
        </div>
      )}
      {preview && !running && (
        <div className="row" style={{ gap: 8, margin: '4px 0 8px' }}>
          <button className="btn sm" disabled={!count} onClick={() => setConfirm('hide')}>
            Hide {count} session{count === 1 ? '' : 's'}
          </button>
          <button className="btn sm ghost" disabled={!preview.undoable} onClick={() => setConfirm('undo')}>
            Undo
          </button>
        </div>
      )}
      {result && !running && !result.ok && (
        <div className="amber-text" style={{ margin: '4px 0 8px' }}>
          {result.message}
          {result.skipped.length > 0 && (
            <ul className="mute" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {result.skipped.slice(0, 20).map((s, n) => <li key={n}>{s.label}: {s.reason}</li>)}
            </ul>
          )}
        </div>
      )}
      {confirm === 'hide' && preview && (
        <Confirm
          title="Hide Genio's past sessions?"
          tone="amber"
          confirmLabel={`Hide ${count}`}
          body={`Codex archives ${preview.codex.length} thread${preview.codex.length === 1 ? '' : 's'} (one first, as a check; the rest only if it leaves the Codex app). ${preview.claude.length} Claude folder${preview.claude.length === 1 ? '' : 's'} move into Genio's own Claude folder. Nothing is deleted, and Undo restores all of it.`}
          onConfirm={() => void go('hide')}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'undo' && preview && (
        <Confirm
          title="Put Genio's past sessions back?"
          tone="amber"
          confirmLabel="Undo"
          body={`Unarchives the Codex threads and moves the Claude folders back to your Claude folder (${preview.undoable} item${preview.undoable === 1 ? '' : 's'}). They show in your Codex and Claude apps again.`}
          onConfirm={() => void go('undo')}
          onClose={() => setConfirm(null)}
        />
      )}
    </Part>
  )
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
    <Row label={k.label} hint={spend?.costed ? `spend today ${usd(spend.todayUsd)} · 7 days ${usd(spend.weekUsd)}` : undefined}>
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
      toast('error', 'Update check failed', errText(e))
    } finally {
      setBusy(false)
    }
  }
  // Checks only on a click: opening Settings never runs git fetch.
  return (
    <Part id="settings-updates" title="Updates">
      <button className="btn" disabled={busy} onClick={() => void check()}>
        <RefreshCw size={13} className={busy ? 'spin' : ''} /> Check for updates
      </button>
      {info && (
        <div className="patch panel" style={{ marginTop: 14 }}>
          {!info.isGitCheckout ? (
            <div className="mute">This install is not a git checkout; update by reinstalling.</div>
          ) : (
            <>
              {info.error && <div className="alert-text mono" style={{ fontSize: 12 }}>{info.error}</div>}
              {info.incoming.length > 0 && (
                <ul className="patch-list mono">
                  {info.incoming.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
              {info.behind === 0 ? (
                <div className="volt-text">
                  <Wrench size={13} /> Up to date.
                </div>
              ) : (
                <button className="btn solid" style={{ marginTop: 12 }} disabled={!info.canFastForward} onClick={() => setConfirm(true)}>
                  Update and restart
                </button>
              )}
              {info.behind > 0 && !info.canFastForward && <div className="amber-text" style={{ marginTop: 8 }}>Cannot fast-forward cleanly (local changes or divergence).</div>}
            </>
          )}
        </div>
      )}
      {confirm && (
        <Confirm
          title="Update Genio?"
          tone="neon"
          confirmLabel="Update and restart"
          body="Genio fast-forwards, reinstalls dependencies if needed and restarts. Units keep their isolated copies and respawn on the new version."
          onConfirm={async () => {
            await op('Update', () => api().applyUpdate())
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </Part>
  )
}
