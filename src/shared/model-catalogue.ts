export type ModelRuntime = 'claude' | 'codex' | 'gemini' | 'opencode'
export type ModelAccountState = 'connected' | 'free-no-login' | 'sign-in-needed' | 'unavailable'
export interface CatalogueModel {
  key: string
  runtime: ModelRuntime
  provider: string
  id: string
  name: string
  aliases: string[]
  hidden: boolean
  images?: boolean
  efforts: string[]
}
export interface CatalogueRoute {
  runtime: ModelRuntime
  provider: string
  state: ModelAccountState
  accountLabel?: string
  reason?: string
  sourceAt?: string
  checkedAt: string
  lastResult: 'ok' | 'error'
  stale: boolean
  models: CatalogueModel[]
}
export interface ModelCatalogue { routes: CatalogueRoute[] }
export interface RawModel {
  value?: string; resolvedModel?: string; id?: string; model?: string; modelId?: string
  displayName?: string; name?: string; hidden?: boolean
  supportedEffortLevels?: string[]; supportedReasoningEfforts?: { reasoningEffort: string }[]
  inputModalities?: string[]
}
export function normalizeModels(runtime: ModelRuntime, provider: string, rows: RawModel[]): CatalogueModel[] {
  const found = new Map<string, CatalogueModel>()
  for (const row of rows) {
    const id = row.resolvedModel || row.model || row.modelId || row.id || row.value
    if (!id) continue
    const alias = row.value || row.id || id
    const prior = found.get(id)
    if (prior) {
      prior.aliases = [...new Set([...prior.aliases, alias])]
      if (alias !== 'default') prior.name = row.displayName || row.name || prior.name
      prior.efforts = [...new Set([...prior.efforts, ...(row.supportedEffortLevels || [])])]
      continue
    }
    found.set(id, { key: `${runtime}:${provider}:${id}`, runtime, provider, id,
      name: row.displayName || row.name || id, aliases: [alias], hidden: row.hidden === true,
      images: row.inputModalities ? row.inputModalities.includes('image') : undefined,
      efforts: row.supportedEffortLevels || row.supportedReasoningEfforts?.map(x => x.reasoningEffort) || [] })
  }
  return [...found.values()]
}
export function modelState(installed: boolean, login: string, error?: string): ModelAccountState {
  if (!installed) return 'unavailable'
  if (/API key is missing|not configured|not logged in|authentication required|unauthenticated/i.test(error || '')) return 'sign-in-needed'
  if (error) return 'unavailable'
  return login === 'logged-in' ? 'connected' : login === 'logged-out' ? 'sign-in-needed' : 'unavailable'
}
export function filterModels(models: CatalogueModel[], search: string, provider = '', internal = false): CatalogueModel[] {
  const words = search.toLowerCase().trim().split(/\s+/)
  return models.filter(m => (internal || !m.hidden) && (!provider || m.provider === provider) &&
    words.every(word => `${m.name} ${m.id} ${m.provider} ${m.runtime} ${m.aliases.join(' ')}`.toLowerCase().includes(word)))
}
export function canDrive(route: CatalogueRoute): boolean {
  return route.runtime === 'claude' && route.state === 'connected' && !route.stale
}
