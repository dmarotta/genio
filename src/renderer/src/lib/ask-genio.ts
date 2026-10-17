import { PROJECT_WKSP, PROJECT_WINDOW, api, getState, op, openChat } from '../store'
import { getScreenContext, openGenioPanel, screenContextFor } from './screen-context'
import { askGenioMessage } from './choice'

/** Choice cards and tips share the normal player-message path and the current screen context. */
export async function sendAskGenio(question: Parameters<typeof askGenioMessage>[0], wksp: string, project?: string, asker?: string): Promise<boolean> {
  const { view } = getState()
  const context = screenContextFor(view, PROJECT_WINDOW ?? project ?? '', getScreenContext(view))
  const sent = await op('Ask Genio', async () => { await api().sendChat(wksp, askGenioMessage(question, asker), undefined, context); return true })
  if (!sent) return false
  if (PROJECT_WKSP) { if (view !== 'comms') openGenioPanel() }
  else openChat(wksp)
  return true
}
