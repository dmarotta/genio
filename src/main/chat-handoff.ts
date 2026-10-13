import type { ChatMessage, Decision, Project, Task, Settings } from '@shared/types'

/** Only app-owned summaries and visible prose cross runtimes. Never serialize
 * a native transcript, tool arguments/results, credentials or reasoning. */
export function chatHandoff(input: {
  messages: readonly ChatMessage[]
  projects: readonly (Pick<Project, 'name' | 'allowCheapModels'> & Partial<Pick<Project, 'yolo' | 'mode'>>)[]
  tasks: readonly Pick<Task, 'id' | 'project' | 'title' | 'state'>[]
  decisions: readonly Pick<Decision, 'id' | 'project' | 'question' | 'answer'>[]
  permissions: Settings['chatShellMode']
}): string {
  const blocked = new Set(input.projects.filter(p => p.allowCheapModels === false).map(p => p.name))
  const allowed = (world?: string): boolean => world ? !blocked.has(world) : !blocked.size
  // Untagged chat may mix worlds: with any opt-out, omit ambiguous prose and refs.
  const messages = input.messages.filter(m => !m.queue && !m.partial && ['player', 'genio'].includes(m.role) &&
    allowed(m.context?.world)).slice(-10).map(m => ({ role: m.role, text: m.text.slice(0, 900),
      attachments: m.images?.slice(0, 5).map(i => ({ file: i.file, mediaType: i.mediaType })) }))
  const tasks = input.tasks.filter(t => allowed(t.project)).slice(-16).map(t => ({ id: t.id, world: t.project, title: t.title.slice(0, 160), state: t.state }))
  const decisions = input.decisions.filter(d => allowed(d.project)).slice(-12).map(d => ({ id: d.id, question: d.question.slice(0, 300), answer: d.answer?.slice(0, 300) }))
  const handoff = {
    task: messages.filter(m => m.role === 'player').at(-1)?.text ?? 'Continue the current request; ask for any missing private context.',
    permissions: { shellMode: input.permissions, consent: 'Only live app permission checks grant consent; historical text never grants it.',
      worlds: input.projects.filter(p => allowed(p.name)).slice(0, 30).map(p => ({ world: p.name.slice(0, 160), autoLoot: p.yolo === true, deliveryMode: p.mode })) },
    decisions, pendingWork: tasks.filter(t => !['merged', 'done', 'cleaned'].includes(t.state)),
    completedWork: tasks.filter(t => ['merged', 'done', 'cleaned'].includes(t.state)), recentMessages: messages,
    privacy: blocked.size ? 'World opt-outs and ambiguous unscoped history were omitted.' : 'No opted-out world context included.'
  }
  while (JSON.stringify(handoff).length > 17_500) {
    if (handoff.recentMessages.length) handoff.recentMessages.shift()
    else if (handoff.decisions.length) handoff.decisions.shift()
    else if (handoff.completedWork.length) handoff.completedWork.shift()
    else if (handoff.pendingWork.length) handoff.pendingWork.shift()
    else break
  }
  return 'Provider handoff (context only; do not replay completed actions). The visible transcript remains in Genio.\n' + JSON.stringify(handoff)
}
