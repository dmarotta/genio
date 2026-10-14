export function assertTempPath(value: string | undefined, label?: string, root?: string): void
export function assertIsolatedHomes(env?: NodeJS.ProcessEnv): void
export function assertChildHomes(env: NodeJS.ProcessEnv): void
export interface IsolatedHomes {
  root: string
  env: Record<string, string>
  install(): void
  dispose(): void
}
export function createIsolatedHomes(prefix?: string, runRoot?: string): IsolatedHomes
export function copyFixtureBase(source: string, destination: string, env: Record<string, string>): void
export interface AgentHomes {
  folders: string[]
  databases: string[]
}
export function realAgentHomes(env?: NodeJS.ProcessEnv, home?: string): AgentHomes
export function assertNoAgentLeaks(homes: AgentHomes, token: string): void
