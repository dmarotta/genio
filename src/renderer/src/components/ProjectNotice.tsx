import { proposalLine } from '@shared/engine'
import { PROJECT_WINDOW, api, op, useStore } from '../store'
import { openSettings } from '../lib/settings-nav'

/** A retired engine set by hand that detection does not pick: shown until dismissed. In the window shell, apart from Settings.
 * Opening a folder shows no notice: the setup greeting in the chat says what a new folder needs. */
export function ProjectNotice() {
  const project = useStore(s => s.snap.projects.find(p => p.name === PROJECT_WINDOW))
  const proposal = project && proposalLine(project)
  if (!project || !proposal) return null
  return <div role="status" className="project-notice">
    <span className="project-notice-text">{project.name}<span className="amber-text"> · {proposal}</span></span>
    <button className="btn sm ghost" onClick={() => openSettings('project', 'settings-engine')}>Settings</button>
    <button className="btn sm ghost" aria-label="Dismiss engine proposal" onClick={() => void op('Engine proposal', () => api().projectUpdate(project.name, { engineProposal: undefined }))}>Dismiss</button>
  </div>
}
