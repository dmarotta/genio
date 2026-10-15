import { modelState, normalizeModels, staticClaudeCatalogue, type CatalogueRoute, type ModelCatalogue, type ModelRuntime, type RawModel } from '@shared/model-catalogue'
import { runtimeAccounts } from '@shared/api'
import { settingsPath } from '@shared/settings-pages'
import { bus } from './bus'
import { listAccounts, scrubDetail } from './accounts'
import { claudeModels, codexModels, geminiModels, opencodeModels } from './model-discovery'
import { getSecret } from './secrets'

export const CATALOGUE_TTL = 5 * 60_000
let cached: ModelCatalogue = { routes: [] }
let expires = 0
let generation = 0
let pending: Promise<ModelCatalogue> | undefined
let pendingGeneration = 0
export function invalidateModelCatalogue(): void { expires = 0; generation++; bus.publish({ type: 'model-catalogue-invalidated' }) }
/** A failed chat route remains unavailable until an explicit Accounts refresh. */
const unavailable = new Map<ModelRuntime, string>()
export function markChatRouteUnavailable(runtime: ModelRuntime, reason: string): void {
  unavailable.set(runtime, reason)
  cached = { routes: cached.routes.map(r => r.runtime === runtime ? { ...r, state: 'unavailable', lastResult: 'error', reason } : r) }
}
export function chatRouteUnavailable(runtime: ModelRuntime): string | undefined { return unavailable.get(runtime) }
export function modelCatalogue(dataDir: string, refresh = false, claudePath?: string): Promise<ModelCatalogue> {
  if (refresh) unavailable.clear()
  if (pending) return refresh && pendingGeneration !== generation ? pending.then(() => modelCatalogue(dataDir, true, claudePath)) : pending
  if (!refresh && Date.now() < expires) return Promise.resolve(cached)
  const started = generation
  pendingGeneration = started
  pending = (async () => {
    const accounts = runtimeAccounts(await listAccounts())
    const key = getSecret('openrouter', dataDir)
    const discover = async (runtime: ModelRuntime, provider: string, probe: () => Promise<RawModel[]>): Promise<CatalogueRoute> => {
      const account = accounts.find(a => a.tool === runtime)
      const previous = cached.routes.find(r => r.runtime === runtime && r.provider === provider)
      const route: CatalogueRoute = { runtime, provider, state: modelState(!!account?.installed, account?.state || 'unknown'),
        accountLabel: runtime === 'codex' && /ChatGPT/i.test(account?.detail || '') ? 'ChatGPT' : undefined,
        checkedAt: new Date().toISOString(), lastResult: 'error', stale: !!previous?.models.length,
        sourceAt: previous?.sourceAt, models: previous?.models.length ? previous.models : runtime === 'claude' ? staticClaudeCatalogue().routes[0].models : [] }
      if (unavailable.has(runtime)) { route.state = 'unavailable'; route.reason = unavailable.get(runtime); return route }
      if (!account?.installed) { route.reason = 'CLI is not installed'; return route }
      if (provider === 'OpenRouter' && !key) { route.state = 'sign-in-needed'; route.reason = `Add an OpenRouter key in ${settingsPath('accounts', 'API keys')}`; return route }
      if ((runtime === 'claude' || runtime === 'codex') && route.state !== 'connected') {
        route.reason = route.state === 'sign-in-needed' ? `Sign in through ${settingsPath('accounts')}` : 'Account status could not be verified'; return route
      }
      try {
        const models = normalizeModels(runtime, provider, await probe())
        if (!models.length) throw new Error('No models returned by this account')
        route.models = models
        route.state = runtime === 'opencode' ? (provider === 'OpenCode' ? 'free-no-login' : 'connected') : 'connected'
        route.sourceAt = new Date().toISOString(); route.lastResult = 'ok'; route.stale = false
        if (provider === 'OpenRouter') route.reason = 'Stored key; catalogue candidates, inference not verified'
      } catch (error) {
        const message = (error as Error).message
        route.state = modelState(true, account.state, message)
        route.reason = scrubDetail(message) || 'Discovery failed'
      }
      return route
    }
    const routes = await Promise.all([
      discover('claude', 'Anthropic', () => claudeModels(claudePath?.trim() || undefined)), discover('codex', 'OpenAI', codexModels),
      discover('gemini', 'Google', geminiModels), discover('opencode', 'OpenCode', () => opencodeModels('opencode', undefined, refresh)),
      discover('opencode', 'OpenRouter', () => opencodeModels('openrouter', key, refresh))
    ])
    // A login/logout during a probe invalidates all its evidence, even if it succeeded.
    cached = { routes: started === generation ? routes : routes.map(r => ({ ...r, stale: true })) }
    expires = started === generation ? Date.now() + (routes.some(r => r.lastResult === 'error') ? 60_000 : CATALOGUE_TTL) : 0
    return cached
  })().catch(() => {
    expires = Date.now() + 60_000
    if (!cached.routes.some(r => r.models.length)) cached = staticClaudeCatalogue()
    return cached
  }).finally(() => { pending = undefined })
  return pending
}
