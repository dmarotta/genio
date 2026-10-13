import { useEffect, useState, type ReactNode } from 'react'
import { Flame, Lock, Trophy } from 'lucide-react'
import type { LedgerRecord } from '@shared/types'
import { api, useStore } from '../store'
import { ViewHeader } from '../components/ui'
import { clock, cx, dateShort, usd } from '../lib/format'

export function CharacterSheet() {
  const stats = useStore((s) => s.snap.stats)
  const tasks = useStore((s) => s.snap.tasks)
  const [ledger, setLedger] = useState<LedgerRecord[]>([])

  useEffect(() => {
    let active = true
    void api().ledgerTail(60).then((records) => {
      if (active) setLedger(records.slice().reverse())
    }).catch(() => {
      if (active) setLedger([])
    })
    return () => { active = false }
  }, [tasks])
  const pct = stats.xpNext ? Math.min(100, (stats.xp / stats.xpNext) * 100) : 0
  const unlocked = stats.achievements.filter((a) => a.unlockedAt).length

  return (
    <div className="view character-sheet">
      <ViewHeader kicker="Level, XP & achievements" title={<>Character <span className="accent">Sheet</span></>} />

      <div className="stats-row">
        <section className="panel stats-card ticks">
          <div className="level-big">
            <div className="lv-hex">
              <svg viewBox="0 0 100 100" width="92" height="92">
                <polygon points="50,3 93,27 93,73 50,97 7,73 7,27" fill="rgba(198,255,61,0.06)" stroke="var(--volt)" strokeWidth="2" />
              </svg>
              <div className="lv-num num">{stats.level}</div>
            </div>
            <div className="lv-meta">
              <div className="label">Level</div>
              <div className="bar" style={{ ['--c' as string]: 'var(--volt)', marginTop: 8 }}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <div className="mute mono" style={{ marginTop: 6, fontSize: 12 }}>
                {stats.xp} / {stats.xpNext} XP
              </div>
            </div>
          </div>
          <div className="stat-tiles">
            <Tile label="Shipped today" value={stats.shippedToday} tone="volt" />
            <Tile label="Shipped total" value={stats.shippedTotal} tone="neon" />
            <Tile label="Recons" value={stats.scoutsTotal} tone="violet" />
            <Tile label="Streak" value={`${stats.streakDays}d`} tone="amber" icon={<Flame size={14} />} />
            <Tile label="Chat/review estimate today" value={usd(stats.costTodayUsd)} tone="mute" />
          </div>
        </section>
        <section className="panel achv-grid-card">
          <header className="card-head">
            <span className="label">Achievements</span>
            <span className="num dim">
              {unlocked}/{stats.achievements.length}
            </span>
          </header>
          <div className="achv-grid">
            {stats.achievements.map((a) => (
              <div key={a.id} className={cx('achv-tile', a.unlockedAt ? 'got' : 'locked')} title={a.description}>
                <div className="achv-ico">{a.unlockedAt ? <Trophy size={18} /> : <Lock size={16} />}</div>
                <div className="achv-tname">{a.name}</div>
                <div className="achv-tdesc">{a.unlockedAt ? dateShort(a.unlockedAt) : a.description}</div>
              </div>
            ))}
            {!stats.achievements.length && <div className="mute">No achievements defined.</div>}
          </div>
        </section>
      </div>

      <section className="panel replay">
        <header className="card-head">
          <span className="label">Replay log</span>
          <span className="mute" style={{ fontSize: 12 }}>
            {ledger.length ? 'Newest first' : 'Enable the Replay log in Systems to record squad activity'}
          </span>
        </header>
        <div className="replay-list mono">
          {ledger.map((r, i) => (
            <div key={i} className="replay-row">
              <span className="mute">{dateShort(r.ts)} {clock(r.ts)}</span>
              <span className="replay-ev">{r.event}</span>
              <span className="dim">{r.task ?? r.project ?? ''}</span>
              <span className="mute replay-data">{r.data ? JSON.stringify(r.data).slice(0, 140) : ''}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
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
