import { useEffect, useState } from 'react'
import { Check, FolderOpen, Gamepad2, Wrench } from 'lucide-react'
import type { ToolStatus } from '@shared/types'
import { api, errText, op, saveSettings, toast, useStore } from '../store'
import { GenioCore } from './GenioCore'
import { Field, Toggle } from './ui'
import { cx } from '../lib/format'

/** First run: gamertag → toolchain check → first world. */
export function Onboarding() {
  const settings = useStore((s) => s.settings)
  const projects = useStore((s) => s.snap.projects)
  const [step, setStep] = useState(0)
  const [tag, setTag] = useState('')
  const [tools, setTools] = useState<ToolStatus[] | null>(null)
  const [source, setSource] = useState('')
  const [inPlace, setInPlace] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (settings) setTag(settings.gamertag && settings.gamertag !== 'Player' ? settings.gamertag : '')
  }, [settings?.firstRunDone]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step === 1 && !tools) void api().toolchain().then(setTools).catch(() => setTools([]))
  }, [step, tools])

  if (!settings || settings.firstRunDone) return null

  const finish = async (): Promise<void> => {
    await saveSettings({ firstRunDone: true, gamertag: tag.trim() || 'Player' })
  }

  const steps = ['Player', 'Loadout', 'First world']

  return (
    <div className="modal-scrim strong">
      <div className="onboard panel glow ticks rise">
        <div className="onboard-side">
          <GenioCore size={96} state="active" />
          <div className="title" style={{ fontSize: 34, marginTop: 18 }}>
            NEW <span className="accent">GAME</span>
          </div>
          <p className="dim">Talk to Genio. Genio runs the squad. You make the calls that matter.</p>
          <ol className="onboard-steps">
            {steps.map((s, i) => (
              <li key={s} className={cx(i === step && 'on', i < step && 'done')}>
                <span className="num">{i < step ? <Check size={12} /> : i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <div className="onboard-main">
          {step === 0 && (
            <>
              <div className="label">Step 1</div>
              <h2 className="modal-title">Choose your gamertag</h2>
              <p className="dim">Genio addresses you by it. Change it anytime in Systems.</p>
              <Field label="Gamertag">
                <input className="input big" autoFocus value={tag} placeholder="Player" maxLength={32} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setStep(1)} />
              </Field>
              <div className="onboard-foot">
                <span />
                <button className="btn solid" onClick={() => setStep(1)}>
                  Continue
                </button>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <div className="label">Step 2</div>
              <h2 className="modal-title">Check your loadout</h2>
              <p className="dim">Units are coding-agent CLIs. Git is required; GitHub CLI unlocks PRs. Nothing installs without your click.</p>
              <div className="tool-list">
                {!tools && <div className="bar indeterminate"><i /></div>}
                {tools?.map((t) => (
                  <div key={t.name} className="tool-row">
                    <span className={cx('dot')} style={{ ['--c' as string]: t.found ? 'var(--volt)' : t.required ? 'var(--alert)' : 'var(--text-mute)' }} />
                    <b className="mono">{t.name}</b>
                    <span className="mute tool-purpose">{t.purpose}</span>
                    <span className="mono mute">{t.found ? t.version ?? 'ok' : t.required ? 'required' : 'optional'}</span>
                    {!t.found && t.install && (
                      <button
                        className="btn sm"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true)
                          await op(`Install ${t.name}`, () => api().installTool(t.name))
                          setTools(await api().toolchain().catch(() => tools))
                          setBusy(false)
                        }}
                      >
                        <Wrench size={12} /> Install
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="onboard-foot">
                <button className="btn ghost" onClick={() => setStep(0)}>
                  Back
                </button>
                <button className="btn solid" onClick={() => setStep(2)}>
                  Continue
                </button>
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="label">Step 3</div>
              <h2 className="modal-title">Load your first world</h2>
              <p className="dim">A git repo with your game: a URL, owner/repo, or a folder on disk. Genio detects the engine.</p>
              {projects.length > 0 ? (
                <div className="tool-list">
                  {projects.map((p) => (
                    <div key={p.name} className="tool-row">
                      <Gamepad2 size={14} className="volt-text" />
                      <b>{p.name}</b>
                      <span className="mute mono">{p.engine}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <Field label="Source">
                    <div className="row">
                      <input className="input mono" value={source} placeholder="https://github.com/you/game  ·  you/game  ·  C:\\dev\\game" onChange={(e) => setSource(e.target.value)} />
                      <button
                        className="btn icon"
                        title="Pick folder"
                        onClick={async () => {
                          const d = await api().pickDirectory()
                          if (d) {
                            setSource(d)
                            setInPlace(true)
                          }
                        }}
                      >
                        <FolderOpen size={16} />
                      </button>
                    </div>
                  </Field>
                  <Toggle checked={inPlace} onChange={setInPlace} label="Use local folder in place (don't clone)" />
                  <div style={{ marginTop: 14 }}>
                    <button
                      className="btn"
                      disabled={busy || !source.trim()}
                      onClick={async () => {
                        setBusy(true)
                        try {
                          const isLocal = /^[a-zA-Z]:[\\/]|^[\\/]/.test(source.trim())
                          const p = await api().projectAdd({ source: source.trim(), inPlace: isLocal && inPlace })
                          toast('success', 'World loaded', `${p.name} · ${p.engine}`)
                          setSource('')
                        } catch (e) {
                          toast('error', 'Could not add world', errText(e))
                        } finally {
                          setBusy(false)
                        }
                      }}
                    >
                      Add world
                    </button>
                  </div>
                </>
              )}
              <div className="onboard-foot">
                <button className="btn ghost" onClick={() => setStep(1)}>
                  Back
                </button>
                <button className="btn solid volt" onClick={() => void finish()}>
                  {projects.length ? 'Start game' : 'Skip for now'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
