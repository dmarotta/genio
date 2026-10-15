import type { ReactNode } from 'react'
import { settingsPage, type SettingsPageId } from '@shared/settings-pages'

/** A Settings page heading: the plain name, the game term as a hint, optional page actions, and the one-sentence intro. */
export function SettingsTitle({ page, children }: { page: SettingsPageId; children?: ReactNode }) {
  const { label, term, intro } = settingsPage(page)
  return (
    <>
      <h2 className="sys-title">
        {label}
        {term && <span className="sys-term">({term})</span>}
        {children}
      </h2>
      {intro && <p className="mute sys-intro">{intro}</p>}
    </>
  )
}

/** A longer explanation kept out of the way: help text stays short, the detail is one click away. */
export function LearnMore({ children }: { children: ReactNode }) {
  return (
    <details className="sys-more">
      <summary>Learn more</summary>
      <div className="mute">{children}</div>
    </details>
  )
}
