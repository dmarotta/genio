import { modelState, normalizeModels, type CatalogueRoute, type ModelCatalogue, type ModelRuntime, type RawModel } from '@shared/model-catalogue'
import { listAccounts, scrubDetail } from './accounts'
import { claudeModels, codexModels, geminiModels, opencodeModels } from './model-discovery'
import { getSecret } from './secrets'

export const CATALOGUE_TTL = 5 * 60_000
let cached: ModelCatalogue = { routes: [] }
let expires = 0
let generation = 0
let pending: Promise<ModelCatalogue> | undefined
let pendingGeneration = 0
export function invalidateModelCatalogue(): void { expires = 0; generation++ }
export function modelCatalogue(dataDir: string, refresh = false, claudePath?: string): Promise<ModelCatalogue> {
  if (pending) return refresh && pendingGeneration !== generation ? pending.then(() => modelCatalogue(dataDir, true, claudePath)) : pending
  if (!refresh && Date.now() < expires) return Promise.resolve(cached)
  const started = generation
  pendingGeneration = started
  pending = (async () => {
    const accounts = await listAccounts()
    const key = getSecret('openrouter', dataDir)
    const discover = async (runtime: ModelRuntime, provider: string, probe: () => Promise<RawModel[]>): Promise<CatalogueRoute> => {
      const account = accounts.find(a => a.tool === runtime)
      const previous = cached.routes.find(r => r.runtime === runtime && r.provider === provider)
      const route: CatalogueRoute = { runtime, provider, state: modelState(!!account?.installed, account?.state || 'unknown'),
        accountLabel: runtime === 'codex' && /ChatGPT/i.test(account?.detail || '') ? 'ChatGPT' : undefined,
        checkedAt: new Date().toISOString(), lastResult: 'error', stale: !!previous?.models.length,
        sourceAt: previous?.sourceAt, models: previous?.models || [] }
      if (!account?.installed) { route.reason = 'CLI is not installed'; return route }
      if (provider === 'OpenRouter' && !key) { route.state = 'sign-in-needed'; route.reason = 'Add an OpenRouter key in Accounts'; return route }
      if ((runtime === 'claude' || runtime === 'codex') && route.state !== 'connected') {
        route.reason = route.state === 'sign-in-needed' ? 'Sign in through Accounts' : 'Account status could not be verified'; return route
      }
      try {
        route.models = normalizeModels(runtime, provider, await probe())
        route.state = runtime === 'opencode' ? (provider === 'OpenCode' ? 'free-no-login' : 'connected') : 'connected'
        route.sourceAt = new Date().toISOString(); route.lastResult = 'ok'; route.stale = false
        if (provider === 'OpenRouter') route.reason = 'Stored key; catalogue candidates, inference not verified'
        if (!route.models.length) route.reason = 'No models returned by this account'
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
    expires = started === generation ? Date.now() + CATALOGUE_TTL : 0
    return cached
  })().finally(() => { pending = undefined })
  return pending
}
