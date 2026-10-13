import { FileImage, Folder, ListChecks, Monitor, X } from 'lucide-react'
import { useState } from 'react'
import { chipKey, visibleContext, type ContextChip, type InventoryContext, type InventoryContextReceipt } from '@shared/inventory-context'
import { chatImageUrl } from '@shared/chat-images'
import { inventoryContextBlock, validateInventoryContext } from '@shared/inventory-context'
import { getDraftContext, setDraftContext } from '../drafts'
import '../styles/genio-panel.css'

export function InventoryContextChips({ context, remove, wksp }: { context?: InventoryContextReceipt; wksp?: string; remove?: (chip: ContextChip) => void }) {
  if (!context) return null
  const chips: { id: ContextChip; label: string; title: string; icon: typeof Folder }[] = []
  const screen = context.screen
  if (screen) chips.push({ id: 'screen', label: [screen.label, ...(screen.facts ?? []).slice(0, 2).map(f => f.value)].join(' · '),
    title: [screen.label, ...(screen.facts ?? []).map(f => `${f.label}: ${f.value}`)].join('\n'), icon: Monitor })
  if (context.folder !== undefined) chips.push({ id: 'folder', label: context.folder.split('/').pop() || 'Project root', title: context.folder || '/', icon: Folder })
  if (context.preview) chips.push({ id: 'preview', label: context.preview.path.split('/').pop()!, title: context.preview.path, icon: FileImage })
  if (context.selection?.length) chips.push({ id: 'selection', label: `${context.selection.length} selected`, title: context.selection.map(a => a.path).join('\n'), icon: ListChecks })
  return <div className="inventory-context" aria-label={remove ? 'Context to send' : 'Sent screen context'}>
    <span className="inventory-context-world" title={inventoryContextBlock(context)}>{context.world}</span>
    {chips.map(({ id, label, title, icon: Icon }) => <span className="inventory-context-chip" key={id} title={title}><Icon size={12} /><span>{label}</span>{remove && <button aria-label={`Remove ${id} context`} onClick={() => remove(id)}><X size={12} /></button>}</span>)}
    {wksp && context.thumbnail?.image && <img className="inventory-context-thumb" src={chatImageUrl(wksp, context.thumbnail.image.file)} alt="Shared preview" />}
    {context.thumbnail && <small className="dim">{context.thumbnail.status === 'attached' ? 'Preview attached' : context.thumbnail.status === 'reused' ? 'Preview already shared' : context.thumbnail.status === 'attachment-limit' ? 'Preview omitted: attachment limit' : 'Preview image unavailable'}</small>}
  </div>
}

/** An edited queued snapshot takes precedence until sent/removed; normal chips follow the current screen. */
export function useInventoryContext(wksp: string, live?: InventoryContext) {
  const [restored, setRestored] = useState(() => getDraftContext(wksp))
  const [dismissed, setDismissed] = useState<Partial<Record<ContextChip, string>>>({})
  const source = restored ?? live
  const context = source && visibleContext(source, dismissed)
  return {
    context,
    chips: <InventoryContextChips context={context} remove={chip => {
      if (!source) return
      setDismissed(d => ({ ...d, [chip]: chipKey(source, chip) }))
      if (restored) { const next = { ...restored }; delete next[chip]; setRestored(next); setDraftContext(wksp, next) }
    }} />,
    restore: (c?: InventoryContext) => { const clean = c && validateInventoryContext(c); setRestored(clean); setDraftContext(wksp, clean); setDismissed({}) },
    sent: () => { setRestored(undefined); setDraftContext(wksp, undefined) }
  }
}
