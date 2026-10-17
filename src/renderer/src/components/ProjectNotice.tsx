import { detectedLine, detectedView, proposalLine } from '@shared/engine'
import { PROJECT_WINDOW, api, op, setState, useStore } from '../store'
import { MODE_LABEL } from '../lib/vocab'
import { openSettings } from '../lib/settings-nav'

/** Registration is informational and dismissible; settings remain one click away. In the window shell, apart from Settings. */
export function ProjectNotice() {
  const registered = useStore(s => s.registeredProject)
  const project = useStore(s => s.snap.projects.find(p => p.name === PROJECT_WINDOW))
  const proposal = project && proposalLine(project)
  if (!project || (!registered && !proposal && project.gitRepo !== false)) return null
  const view = detectedView(project)
  return <div role="status" className="project-notice">
    <span className="project-notice-text">{registered ? `Registered ${project.name} · ${detectedLine(view)}${view.ambiguous ? ' · ambiguous' : ''} · ${MODE_LABEL[project.mode]}` : project.name}
      {project.gitRepo === false ? ' · Git actions need a git repo' : !project.remote ? ' · No remote' : ''}
      {proposal && <span className="amber-text"> · {proposal}</span>}</span>
    {(registered || proposal) && <button className="btn sm ghost" onClick={() => openSettings('project', 'settings-engine')}>{registered ? 'Change' : 'Settings'}</button>}
    {registered && <button className="btn sm ghost" aria-label="Dismiss registration" onClick={() => setState({ registeredProject: undefined })}>Dismiss</button>}
    {!registered && proposal && <button className="btn sm ghost" aria-label="Dismiss engine proposal" onClick={() => void op('Engine proposal', () => api().projectUpdate(project.name, { engineProposal: undefined }))}>Dismiss</button>}
  </div>
}
