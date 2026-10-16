import { useState } from 'react'
import type { ModellerAct, ModellerLive, ModellerStep } from '@shared/modeller'
import type { Task } from '@shared/types'
import { api, op } from '../store'
import { cx } from '../lib/format'
import { Confirm } from './ui'
import '../styles/modeller-view.css'

/** Why the model cannot change right now, or ''. */
export function modelLocked(t: Task, live: ModellerLive): string {
  if (t.state === 'cleaned') return 'Despawned: the model can no longer change.'
  if (live.running) return `Wait for step ${live.running.n} to finish.`
  return ''
}

const tris = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'triangle' : 'triangles'}`

/**
 * The Steps tab: the current branch as a thumbnail strip (each step's Blender review render), newest
 * first, with Revert to N and Branch from N, a branch switch, and the head step's checks as
 * information only. Every change goes through the kernel and the unit is told what the player did.
 */
export function ModellerSteps({ t, live }: { t: Task; live: ModellerLive }) {
  const [busy, setBusy] = useState(false)
  const [reverting, setReverting] = useState<ModellerStep | null>(null)
  const locked = modelLocked(t, live)
  const head = live.steps.at(-1)
  const act = async (label: string, a: ModellerAct): Promise<void> => {
    setBusy(true)
    try { await op(label, () => api().modellerAct(t.id, a)) } finally { setBusy(false) }
  }
  const off = busy || !!locked
  const later = (s: ModellerStep): number => live.steps.length - 1 - live.steps.indexOf(s)
  return (
    <div className="modeller-steps">
      <div className="ms-head">
        <span className="label">{live.model}</span>
        {live.branches.length > 1 ? (
          <select className="input ms-branch" aria-label="Branch" value={live.branch} disabled={off} title={locked || 'Switch the model to another branch'}
            onChange={(e) => void act('Switch branch', { op: 'switch', model: live.model, branch: e.target.value })}>
            {live.branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        ) : <span className="mute">branch {live.branch}</span>}
      </div>
      {live.running && (
        <div className="ms-step running">
          <div className="ms-thumb"><i className="dot pulse" /></div>
          <div className="ms-main">
            <div className="ms-title">{live.running.n} · {live.running.caption}</div>
            <div className="mute ms-meta">running in Blender…</div>
          </div>
        </div>
      )}
      {!live.steps.length && !live.running && <div className="mute">No steps yet.</div>}
      {[...live.steps].reverse().map((s) => {
        const current = s === head
        return (
          <div key={s.id} className={cx('ms-step', current && 'current')}>
            <div className="ms-thumb">{s.view ? <img src={s.view} alt={`Step ${s.n}: ${s.caption}`} loading="lazy" /> : <span className="mute">no render</span>}</div>
            <div className="ms-main">
              <div className="ms-title" title={s.caption}>{s.n} · {s.caption}</div>
              <div className="mute ms-meta">
                {tris(s.triangles)} · {s.parts} {s.parts === 1 ? 'part' : 'parts'}{s.warnings ? ` · ${s.warnings} ${s.warnings === 1 ? 'warning' : 'warnings'}` : ''}
              </div>
              <div className="ms-actions">
                {current ? <span className="chip orange">Current</span> : (
                  <button className="btn sm ghost" disabled={off} title={locked || `Go back to step ${s.n} on ${live.branch}`} onClick={() => setReverting(s)}>Revert to {s.n}</button>
                )}
                <button className="btn sm ghost" disabled={off} title={locked || `Start a new branch at step ${s.n}; ${live.branch} keeps its steps`}
                  onClick={() => void act('Branch', { op: 'branch', model: live.model, step: s.id })}>Branch from {s.n}</button>
              </div>
            </div>
          </div>
        )
      })}
      {head && (
        <div className="ms-checks">
          <div className="label">Checks on step {head.n} · information only</div>
          {live.checks.length ? <ul>{live.checks.map((c, i) => <li key={i}>{c}</li>)}</ul> : <div className="mute">Nothing to report.</div>}
        </div>
      )}
      {reverting && (
        <Confirm
          title={`Revert to step ${reverting.n}?`}
          tone="orange"
          confirmLabel={`Revert to ${reverting.n}`}
          body={<p>The model goes back to step {reverting.n} · {reverting.caption}. {later(reverting)} later {later(reverting) === 1 ? 'step leaves' : 'steps leave'} branch {live.branch}; use Branch from {reverting.n} instead to keep them. The unit is told and continues from there.</p>}
          onConfirm={() => act('Revert', { op: 'revert', model: live.model, step: reverting.id })}
          onClose={() => setReverting(null)}
        />
      )}
    </div>
  )
}

/** A Squad card's picture of a Modeller: the latest step's render and what it is doing now; an empty frame before any model. */
export function ModellerCardView({ live }: { live: ModellerLive | null }) {
  const head = live?.steps.at(-1)
  const caption = live?.running ? `Step ${live.running.n} · ${live.running.caption}…` : live?.failure ? `Step ${live.failure.n} failed · ${live.failure.caption}` : head ? `Step ${head.n} · ${head.caption}` : 'No steps yet'
  return (
    <div className="modeller-card">
      {head?.view && live ? <img src={head.view} alt={`${live.model}, step ${head.n}`} /> : <div className="modeller-card-empty mute">{live?.model}</div>}
      <div className={cx('modeller-card-caption', live?.failure && !live.running && 'warn')} title={caption}>
        {live?.running && <i className="dot pulse" />}<span>{caption}</span>
      </div>
    </div>
  )
}
