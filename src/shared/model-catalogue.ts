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

export function providerTag(route: Pick<CatalogueRoute, 'runtime' | 'provider'>): string {
  return route.provider === 'OpenRouter' ? 'openrouter' : route.runtime
}
function canonicalName(id: string): string {
  return id.split('/').pop()!.toLowerCase().replace(/-(?:\d{8}|latest)$/, '')
}
export function modelRowLabel(model: CatalogueModel): string {
  const name = canonicalName(model.id).replace(/^(?:claude|gemini|anthropic|openai|google)-/, '')
    .replace(/(\d)-(\d)/g, '$1.$2').replace(/-/g, ' ')
  return `${providerTag(model)} / ${name}`
}
function version(model: CatalogueModel): number[] {
  return (canonicalName(model.id).match(/\d+(?:[.-]\d+)*/)?.[0] || '0').split(/[.-]/).map(Number)
}
/** Default: four per route, newest numeric family/version first, then strongest
 * tier (opus/astra/pro, sonnet/sol, haiku/flash/luna). Older major families are
 * legacy. Unknown families sort deterministically by id. Show all restores older
 * families, but never internal entries or duplicate dated/latest/alias choices.
 */
export function rankedModels(models: CatalogueModel[], showAll = false, limit = 4): CatalogueModel[] {
  const aliases = new Set(models.flatMap(m => m.aliases.filter(a => a !== m.id)))
  const tier = (m: CatalogueModel): number => /opus|astra|ultra|pro/.test(m.id) ? 3 : /sonnet|sol/.test(m.id) ? 2 : 1
  const candidates = models.filter(m => !m.hidden && !aliases.has(m.id) &&
    !/^(default|auto|opus|sonnet|haiku)$|(?:^|[-/])(internal|reserve|auto-review|legacy)(?:$|-)/i.test(m.id))
    .sort((a, b) => {
      const av = version(a), bv = version(b)
      for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        const diff = (bv[i] || 0) - (av[i] || 0)
        if (diff) return diff
      }
      return tier(b) - tier(a) || a.id.localeCompare(b.id)
    })
  const unique = [...new Map(candidates.slice().reverse().map(m => [canonicalName(m.id), m])).values()].reverse()
  if (showAll) return unique
  const newest = Math.max(0, ...unique.map(m => version(m)[0]))
  return unique.filter(m => !/\bdeprecated\b/i.test(m.name) && (version(m)[0] === newest || version(m)[0] === 0)).slice(0, Math.max(0, limit))
}
export function modelSelectionAction(route: CatalogueRoute): 'select' | 'accounts' | 'coming-soon' {
  if (route.state !== 'connected' || route.stale) return 'accounts'
  return canDrive(route) ? 'select' : 'coming-soon'
}
