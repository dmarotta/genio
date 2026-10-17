import type { CSSProperties } from 'react'
import { ModelPicker, useModelCatalogue } from './ModelPicker'
import { EFFORTS } from '../lib/vocab'
import { openSettings } from '../lib/settings-nav'

/** The model and effort pickers of the chat composer and Settings (kept apart from Settings so the chat loads without it). */
type SelectProps = { value: string; onChange: (v: string) => void; title?: string; disabled?: boolean; style?: CSSProperties }
export function ModelSelect(props: SelectProps) {
  return <ModelPicker {...props} onAccounts={() => openSettings('accounts', 'settings-api-keys')} />
}

export function EffortSelect({ value, onChange, model, ...rest }: SelectProps & { model?: string }) {
  const catalogue = useModelCatalogue()
  const selected = catalogue.routes.flatMap(r => r.models).find(m => (m.key === model || m.runtime === 'claude' && (m.id === model || m.aliases.includes(model || 'default'))))
  const efforts = (model === undefined ? EFFORTS : selected?.efforts || []).filter(e => e !== 'ultra')
  return (
    <select className="select" value={efforts.includes(value) ? value : ""} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="">(auto)</option>
      {efforts.map((x) => (
        <option key={x} value={x}>
          {x}
        </option>
      ))}
    </select>
  )
}
