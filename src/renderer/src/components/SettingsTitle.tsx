import type { ReactNode } from 'react'
import { settingsPage, type SettingsPageId } from '@shared/settings-pages'

/** A Settings page heading: the plain name, the game term as a hint, and optional page actions. */
export function SettingsTitle({ page, children }: { page: SettingsPageId; children?: ReactNode }) {
  const { label, term } = settingsPage(page)
  return (
    <h2 className="sys-title">
      {label}
      {term && <span className="sys-term">({term})</span>}
      {children}
    </h2>
  )
}
