import type { ModellerLive } from '@shared/modeller'
import { cx } from '../lib/format'
import '../styles/modeller-view.css'

const tris = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'triangle' : 'triangles'}`

/**
 * The Steps tab: the model's steps as a thumbnail list (each step's Blender review render), newest
 * first, with its caption, triangles and parts. The player steers in words through the ping box.
 */
export function ModellerSteps({ live }: { live: ModellerLive }) {
  const head = live.steps.at(-1)
  return (
    <div className="modeller-steps">
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
      {[...live.steps].reverse().map((s) => (
        <div key={s.id} className={cx('ms-step', s === head && 'current')}>
          <div className="ms-thumb">{s.view ? <img src={s.view} alt={`Step ${s.n}: ${s.caption}`} loading="lazy" /> : <span className="mute">no render</span>}</div>
          <div className="ms-main">
            <div className="ms-title" title={s.caption}>{s.n} · {s.caption}</div>
            <div className="mute ms-meta">{tris(s.triangles)} · {s.parts} {s.parts === 1 ? 'part' : 'parts'}</div>
          </div>
        </div>
      ))}
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
