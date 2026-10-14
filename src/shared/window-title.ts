import { ASSISTANT_NAME } from './assistant'

/** Native titles distinguish project windows in the taskbar and Alt-Tab. */
export function windowTitle(project?: string, chat = false): string {
  return `${ASSISTANT_NAME} - ${project ?? 'Hub'}${chat ? ' (Chat)' : ''}`
}
