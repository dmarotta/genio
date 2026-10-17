import type { ReactNode } from 'react'
import { settingsPage, type SettingsPageId } from '@shared/settings-pages'

/** A Settings page heading: the plain name and optional page actions. */
export function SettingsTitle({ page, children }: { page: SettingsPageId; children?: ReactNode }) {
  return (
    <h2 className="sys-title">
      {settingsPage(page).label}
      {children}
    </h2>
  )
}
