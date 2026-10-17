import { useEffect, useState } from 'react'
import type { Task } from '@shared/types'
import type { ReferenceView } from '@shared/unit-references'
import { briefSummary } from '@shared/unit-brief'
import { api, errText } from '../store'
import '../styles/brief-tab.css'

/** The unit page's Brief tab: the mission in a few plain lines (the header already shows the title). The full brief stays on disk for the unit. */
export function BriefTab({ t }: { t: Task }) {
  const [brief, setBrief] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [refs, setRefs] = useState<ReferenceView[]>([])
  useEffect(() => {
    let alive = true
    setBrief(null)
    setErr('')
    setRefs([])
    void api()
      .readTaskFile(t.id, 'brief')
      .then((s) => { if (alive) setBrief(s ?? '') })
      .catch((e) => { if (alive) { setErr(errText(e)); setBrief('') } })
    // the player's attachments, when the unit got any; nothing shows otherwise
    void Promise.resolve()
      .then(() => api().taskReferences(t.id))
      .then((r) => { if (alive && Array.isArray(r)) setRefs(r) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [t.id, t.briefPath, t.kind])
  if (brief === null) return <div className="bar indeterminate"><i /></div>
  return <BriefSummaryView t={t} brief={brief} err={err} refs={refs} />
}

export function BriefSummaryView({ t, brief, err, refs }: { t: Task; brief: string; err?: string; refs?: ReferenceView[] }) {
  const { ask, summary } = briefSummary(t.summary, brief === '(no brief)' ? '' : brief)
  return (
    <div className="brief-sum">
      <section>
        <div className="brief-label">Your ask</div>
        {ask ? <p className="brief-ask">{ask}</p> : <p className="mute">{err ? 'The brief could not be read.' : 'Not recorded.'}</p>}
      </section>
      <section>
        <div className="brief-label">What the unit will do</div>
        {summary ? <p className="brief-what">{summary}</p> : <p className="mute">No summary.</p>}
      </section>
      {refs?.length ? (
        <section>
          <div className="brief-label">References</div>
          <ul className="brief-refs">
            {refs.map((r) => (
              <li key={r.file}>
                <button type="button" className="brief-ref" onClick={() => void api().openPath(r.path)}>
                  {r.thumb ? <img src={r.thumb} alt="" /> : null}
                  <span className="brief-ref-name">{r.file}</span>
                </button>
                {r.note ? <span className="brief-ref-note">{r.note}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
