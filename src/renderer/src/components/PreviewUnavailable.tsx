import { Box, ExternalLink, FolderOpen } from 'lucide-react'
import { api, op } from '../store'

/** No preview for this asset: the real reason, and actions that work for any file. */
export function PreviewUnavailable({ title, reason, path }: { title: string; reason: string; path: string }) {
  return <div className="inventory-preview-info" role="status">
    <Box size={32} />
    <strong>{title}</strong>
    <p>{reason}</p>
    <div className="inventory-preview-actions">
      <button className="btn sm" onClick={() => { void op('Open asset', () => api().openPath(path)) }}><ExternalLink size={13} /> Open in default app</button>
      <button className="btn sm ghost" onClick={() => { void op('Reveal asset', () => api().revealPath(path)) }}><FolderOpen size={13} /> Reveal</button>
    </div>
  </div>
}
