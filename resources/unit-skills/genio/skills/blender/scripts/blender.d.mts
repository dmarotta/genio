export function assertOutside(dir: string, roots: (string | undefined | null)[], message: string): void
/** Either PYTHONPYCACHEPREFIX (the shared cache) or PYTHONDONTWRITEBYTECODE (no cache for this Blender). */
export function bytecodeEnv(blender: string, dir?: string, platform?: string): { PYTHONPYCACHEPREFIX?: string; PYTHONDONTWRITEBYTECODE?: '1' }
export function runBlender(o: { blender: string; prefix?: string[]; script: string; blend?: string | null; args?: string[]; threads?: number; timeout?: number; scratch: string; env?: Record<string, string> }): Promise<{ code: number | null; timedOut: boolean; log: string; tail: string; ms: number }>
