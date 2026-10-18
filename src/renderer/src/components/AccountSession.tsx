import { X } from 'lucide-react'
import { useStore } from '../store'
import { TerminalView } from './Terminal'

/** A running login/logout terminal (Accounts & keys, the Hub's sign-in): the player finishes any prompts here or in the browser. */
export function AccountSession({ id, onClose }: { id: string; onClose: () => void }) {
  const term = useStore((s) => s.terminals[id])
  return (
    <div className="account-session panel">
      <div className="account-session-head">
        <b>{term?.title ?? 'Session'}</b>
        <span className="mute">{term && !term.alive ? `exited (${term.exitCode ?? '?'})` : 'finish any prompts here or in your browser'}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm ghost icon" title="Close" onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <div className="account-term">
        <TerminalView id={id} autoFocus />
      </div>
    </div>
  )
}
