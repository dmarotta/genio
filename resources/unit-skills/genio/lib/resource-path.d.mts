export interface ResourceLayout { here?: string; resourcesPath?: string }
export function pluginRoots(options?: ResourceLayout): string[]
export function pluginFile(rel: string, options?: ResourceLayout): string
