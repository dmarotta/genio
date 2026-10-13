import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './styles/app.css'
import { App } from './App'
import { boot } from './store'
import { CHAT_POPOUT_HASH } from '@shared/chat-popout'

// The owner renders its live chat into the child via a portal; no second store/session.
if (window.location.hash !== CHAT_POPOUT_HASH) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

  void boot()
}
