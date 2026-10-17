export const WINDOWS_MAX_PATH: number
export const PATH_MARGIN: number
export interface LongestPath { length: number; rel: string; partial: boolean }
export interface LongestPathOptions { packageCache?: string; maxEntries?: number; budgetMs?: number; now?: () => number }
export function longestProjectPath(root: string, options?: LongestPathOptions): Promise<LongestPath>
export function pathWarning(longest: Pick<LongestPath, 'length' | 'rel'> | undefined, options?: { platform?: string }): string | undefined
export function longPathWarning(root: string, options?: LongestPathOptions & { platform?: string }): Promise<string | undefined>
