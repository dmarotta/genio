import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { layerRoot } from '../components/Layer'
import { Award, Crown, Flame, Lock, Medal, Pin, Shield, Trophy, type LucideIcon } from 'lucide-react'
import type { Achievement, LandingDay } from '@shared/types'
import { levelTitle, nextTitle } from '@shared/level-titles'
import { api, errText, toast, useStore } from '../store'
import { ViewHeader } from '../components/ui'
import { cx, dateShort } from '../lib/format'
import { useScreenContext } from '../lib/screen-context'

const MAX_PINS = 3

export function CharacterSheet() {
  const stats = useStore((s) => s.snap.stats)

  useEffect(() => {
    void api().featureUsed('character-sheet').catch(() => {})
  }, [])
  const pct = stats.xpNext ? Math.min(100, (stats.xp / stats.xpNext) * 100) : 0
  // Retired trophies stay on the grid once earned but never count toward the totals.
  const counted = stats.achievements.filter((a) => !a.retired)
  const unlocked = counted.filter((a) => a.unlockedAt).length
  const pins = stats.pins ?? []
  const pinned = pins.map((id) => stats.achievements.find((a) => a.id === id)).filter((a): a is Achievement => Boolean(a?.unlockedAt))
  const ordered = [...pinned, ...stats.achievements.filter((a) => !pinned.includes(a))]
  const next = nextTitle(stats.level)
  useScreenContext('status', { facts: [
    { label: 'Level', value: `${stats.level} · ${stats.xp}/${stats.xpNext} XP · ${stats.streakDays}-day streak` },
    { label: 'Title', value: `${levelTitle(stats.level)}${next ? ` · next: ${next.title} at level ${next.level}` : ''}` },
    { label: 'Achievements', value: `${unlocked} of ${counted.length} unlocked${pinned.length ? ` · pinned: ${pinned.map((a) => a.name).join(', ')}` : ''}` }
  ] })

  return (
    <div className="view character-sheet">
      <ViewHeader title={<>Character <span className="accent">Sheet</span></>} />

      <section className="panel stats-card ticks">
        <div className="level-big">
          <div className="lv-hex">
            <svg viewBox="0 0 100 100" width="92" height="92">
              <polygon points="50,3 93,27 93,73 50,97 7,73 7,27" fill="rgba(198,255,61,0.06)" stroke="var(--volt)" strokeWidth="2" />
            </svg>
            <div className="lv-num num">{stats.level}</div>
          </div>
          <LevelMeta level={stats.level} pct={pct} xp={`${stats.xp} / ${stats.xpNext} XP`} />
        </div>
        <div className="stat-tiles">
          <Tile label="Shipped total" value={stats.shippedTotal} tone="neon" />
          <Tile label="Recons" value={stats.scoutsTotal} tone="violet" />
          <Tile label="Streak" value={`${stats.streakDays}d`} tone="amber" icon={<Flame size={14} />} />
        </div>
        <Landings days={stats.landings ?? []} />
      </section>

      <section className="panel achv-grid-card ticks">
        <header className="card-head">
          <span className="label">Achievements</span>
          <span className="achv-count">
            <span className="num">{unlocked}/{counted.length}</span>
            <span className="mute"> unlocked</span>
          </span>
        </header>
        <Achievements ordered={ordered} pinned={pinned} />
      </section>
    </div>
  )
}

/** One rank icon per band of the title ladder. */
const rankIcon = (level: number): LucideIcon => (level < 12 ? Shield : level < 21 ? Medal : level < 33 ? Award : Crown)

/** Level meta: "Level" with the level's title on one line, the next title, then XP. */
function LevelMeta({ level, pct, xp }: { level: number; pct: number; xp: string }) {
  const Icon = rankIcon(level)
  const next = nextTitle(level)
  return (
    <div className="lv-meta">
      <div className="lv-line">
        <span className="label">Level</span>
        <span className="lv-title">
          <Icon size={13} aria-hidden />
          <span className="lv-title-name">{levelTitle(level)}</span>
        </span>
      </div>
      {next && <div className="lv-next mute">Next: {next.title} at level {next.level}</div>}
      <div className="bar" style={{ ['--c' as string]: 'var(--volt)', marginTop: 8 }}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="mute mono" style={{ marginTop: 6, fontSize: 12 }}>{xp}</div>
    </div>
  )
}

// ------------------------------------------------------------------ achievements grid

/** Compact tiles in reading order; one tab stop, arrows move between tiles and hover or focus shows the full hint. */
function Achievements({ ordered, pinned }: { ordered: Achievement[]; pinned: Achievement[] }) {
  const [focus, setFocus] = useState<number | null>(null)
  const [tip, setTip] = useState<number | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const tiles = useRef<(HTMLDivElement | null)[]>([])
  const last = ordered.length - 1
  const tabStop = focus !== null && focus <= last ? focus : 0

  if (!ordered.length) return <div className="mute">No achievements defined.</div>

  const columns = (): number => {
    const tpl = grid.current ? getComputedStyle(grid.current).gridTemplateColumns : ''
    return Math.max(1, tpl.split(' ').filter(Boolean).length)
  }
  const move = (to: number): void => {
    const i = Math.max(0, Math.min(last, to))
    setFocus(i)
    setTip(i)
    tiles.current[i]?.focus()
  }
  const onKey = (e: KeyboardEvent, i: number): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'ArrowLeft') move(i - 1)
    else if (e.key === 'ArrowRight') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - columns())
    else if (e.key === 'ArrowDown') move(i + columns())
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(last)
    else if (e.key === 'Escape') setTip(null)
    else return
    e.preventDefault()
  }

  return (
    <>
      <div className="achv-grid" ref={grid} role="list" aria-label="Achievements">
        {ordered.map((a, i) => (
          <AchievementTile
            key={a.id}
            a={a}
            pinned={pinned.includes(a)}
            full={pinned.length >= MAX_PINS}
            tileRef={(el) => { tiles.current[i] = el }}
            tabIndex={i === tabStop ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onEnter={() => setTip(i)}
            onLeave={() => setTip((t) => (t === i && focus !== i ? null : t))}
            onFocus={() => { setFocus(i); setTip(i) }}
            onBlur={() => { setFocus(null); setTip((t) => (t === i ? null : t)) }}
          />
        ))}
      </div>
      {tip !== null && ordered[tip] && <AchievementTip a={ordered[tip]} anchor={tiles.current[tip] ?? null} />}
    </>
  )
}

type TileProps = {
  a: Achievement
  pinned: boolean
  full: boolean
  tileRef: (el: HTMLDivElement | null) => void
  tabIndex: number
  onKeyDown: (e: KeyboardEvent) => void
  onEnter: () => void
  onLeave: () => void
  onFocus: () => void
  onBlur: () => void
}

function AchievementTile({ a, pinned, full, tileRef, tabIndex, onKeyDown, onEnter, onLeave, onFocus, onBlur }: TileProps) {
  const toggle = (): void => {
    void api().trophyPin(a.id, !pinned)
      .then((r) => { if (!r.ok) toast('warn', pinned ? 'Trophy not unpinned' : 'Trophy not pinned', r.message) })
      .catch((e) => toast('error', 'Trophy pins not saved', errText(e)))
  }
  const blocked = !pinned && full
  return (
    <div
      ref={tileRef}
      role="listitem"
      tabIndex={tabIndex}
      className={cx('achv-tile', a.unlockedAt ? 'got' : 'locked', pinned && 'pinned ticks')}
      onKeyDown={onKeyDown}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {a.unlockedAt && (
        <button
          type="button"
          className="achv-pin"
          aria-pressed={pinned}
          aria-label={`Pin ${a.name}`}
          title={blocked ? `${MAX_PINS} trophies pinned: unpin one first` : undefined}
          disabled={blocked}
          onClick={toggle}
        >
          <Pin size={13} aria-hidden />
        </button>
      )}
      <div className="achv-ico" aria-hidden>{a.unlockedAt ? <Trophy size={17} /> : <Lock size={14} />}</div>
      <div className="achv-tname">{a.name}</div>
      <div className="achv-tdesc">{a.unlockedAt ? dateShort(a.unlockedAt) : a.description}</div>
    </div>
  )
}

/** The tile already holds the full text for screen readers; the tip shows what the ellipsis cut. */
function AchievementTip({ a, anchor }: { a: Achievement; anchor: HTMLElement | null }) {
  const [ref, style] = useTipPosition(anchor, a.id)
  return createPortal(
    <div ref={ref} className="landings-tip achv-tip ticks" aria-hidden style={style}>
      <div className="landings-tip-date">{a.name}</div>
      <div className="achv-tip-desc">{a.description}</div>
      <div className={cx('achv-tip-state', a.unlockedAt ? 'got' : 'mute')}>{a.unlockedAt ? `Earned ${dateShort(a.unlockedAt)}` : 'Locked'}</div>
    </div>,
    layerRoot()
  )
}

/** Fixed position above the anchor (below it when there is no room), clamped to the window. */
function useTipPosition(anchor: HTMLElement | null, key: string): [RefObject<HTMLDivElement | null>, CSSProperties] {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchor) return
    const a = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, a.left + a.width / 2 - w / 2))
    const above = a.top - h - 8
    setPos({ left, top: above >= 8 ? above : a.bottom + 8 })
  }, [anchor, key])
  return [ref, pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }]
}

// ------------------------------------------------------------------ landings heatmap

const WEEKDAYS = ['M', '', 'W', '', 'F', '', '']

const level = (n: number): string => (n <= 0 ? 'l0' : n === 1 ? 'l1' : n === 2 ? 'l2' : n <= 4 ? 'l3' : 'l4')
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** YYYY-MM-DD is a local calendar day: build the Date from its parts, never parse it as UTC. */
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

function daySummary(d: LandingDay): string {
  if (d.state === 'unknown') return 'Not recorded'
  if (!d.builds && !d.recons) return 'No landings'
  return [d.builds && plural(d.builds, 'build landed', 'builds landed'), d.recons && plural(d.recons, 'recon completed', 'recons completed')].filter(Boolean).join(', ')
}

function Landings({ days }: { days: LandingDay[] }) {
  const weeks = Math.max(1, Math.ceil(days.length / 7))
  const last = days.reduce((i, d, n) => (d.state === 'future' ? i : n), -1)
  const [focus, setFocus] = useState<number | null>(null)
  const [tip, setTip] = useState<number | null>(null)
  const cells = useRef<(HTMLSpanElement | null)[]>([])
  const labelId = useId()
  const tabStop = focus !== null && focus <= last ? focus : last

  const move = (to: number): void => {
    const i = Math.max(0, Math.min(last, to))
    setFocus(i)
    setTip(i)
    cells.current[i]?.focus()
  }
  const onKey = (e: KeyboardEvent, i: number): void => {
    const step: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }
    if (e.key in step) move(i + step[e.key])
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(last)
    else if (e.key === 'Escape') setTip(null)
    else return
    e.preventDefault()
  }

  return (
    <div className="landings" role="group" aria-labelledby={labelId}>
      <div className="landings-head">
        <span className="label" id={labelId}>Landings</span>
      </div>
      <div className="landings-map">
        <div className="landings-wd" aria-hidden>{WEEKDAYS.map((w, i) => <span key={i}>{w}</span>)}</div>
        <div className="landings-grid" role="grid" aria-label={`Landings, last ${weeks} weeks`} style={{ gridTemplateColumns: `repeat(${weeks}, 12px)` }}>
          {Array.from({ length: 7 }, (_, row) => (
            <div role="row" key={row}>
              {Array.from({ length: weeks }, (_, col) => {
                const i = col * 7 + row
                const d = days[i]
                if (!d || d.state === 'future') return <span key={col} role="gridcell" className="lc future" aria-hidden />
                return (
                  <span
                    key={col}
                    ref={(el) => { cells.current[i] = el }}
                    role="gridcell"
                    tabIndex={i === tabStop ? 0 : -1}
                    aria-label={`${dayLabel(d.day)}: ${daySummary(d)}`}
                    className={cx('lc', d.state === 'unknown' ? 'unknown' : level(d.builds + d.recons), i === last && 'today', tip === i && 'active')}
                    onMouseEnter={() => setTip(i)}
                    onMouseLeave={() => setTip((t) => (t === i && focus !== i ? null : t))}
                    onFocus={() => { setFocus(i); setTip(i) }}
                    onBlur={() => { setFocus(null); setTip((t) => (t === i ? null : t)) }}
                    onKeyDown={(e) => onKey(e, i)}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
      {tip !== null && days[tip] && <LandingTip day={days[tip]} anchor={cells.current[tip] ?? null} />}
    </div>
  )
}

/** Hover or keyboard focus shows the day; the cell's own label carries the same text for screen readers. */
function LandingTip({ day, anchor }: { day: LandingDay; anchor: HTMLElement | null }) {
  const [ref, style] = useTipPosition(anchor, day.day)
  return createPortal(
    <div ref={ref} className="landings-tip ticks" aria-hidden style={style}>
      <div className="landings-tip-date">{dayLabel(day.day)}</div>
      {day.state === 'unknown' ? (
        <div className="landings-tip-line mute">No recorded data for this day</div>
      ) : !day.builds && !day.recons ? (
        <div className="landings-tip-line mute">No landings recorded</div>
      ) : (
        <>
          {day.builds > 0 && <div className="landings-tip-line"><i className="dot" style={{ ['--c' as string]: 'var(--volt)' }} />{plural(day.builds, 'build landed', 'builds landed')}</div>}
          {day.recons > 0 && <div className="landings-tip-line"><i className="dot" style={{ ['--c' as string]: 'var(--violet)' }} />{plural(day.recons, 'recon completed', 'recons completed')}</div>}
        </>
      )}
    </div>,
    layerRoot()
  )
}

function Tile({ label, value, tone, icon }: { label: string; value: string | number; tone: string; icon?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-val num" style={{ color: tone === 'mute' ? 'var(--text)' : `var(--${tone})` }}>
        {icon} {value}
      </div>
      <div className="label">{label}</div>
    </div>
  )
}
