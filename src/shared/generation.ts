export interface GenerationCard {
  id: string
  provider: 'fal' | 'uthana' | 'codex'
  world?: string
  model: string
  status: 'awaiting_approval' | 'running' | 'placing' | 'completed' | 'failed'
  estimatedUsd: number
  spentUsd: number
  capUsd?: number
  paths: string[]
  warnings: string[]
  progress?: string
  outputs?: { name: string; kind: string; url?: string; imageId?: string }[]
  error?: string
  /** who approved this paid request and how (absent: not approved yet, or nothing to pay) */
  approval?: string
  /** what the project's Art Bible added to the request (absent: nothing) */
  artBible?: { type: string | null; applied: string[]; refs: string[]; notes?: string[] }
}
