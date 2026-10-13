import { z } from 'zod'

/** Keep legacy MCP arguments and handler types while exposing the project vocabulary. */
export function projectAliasShape(shape: z.ZodRawShape): z.ZodRawShape {
  if (!shape.world || shape.project) return shape
  return { ...shape, world: z.optional(shape.world), project: z.optional(shape.world) }
}

export function normalizeProjectArgs(input: unknown, shape: z.ZodRawShape): unknown {
  if (!shape.world || shape.project || !input || typeof input !== 'object' || Array.isArray(input)) return input
  const { project, ...args } = input as Record<string, unknown>
  if (project === undefined) return args
  if (args.world !== undefined && args.world !== project) throw new Error('Conflicting project arguments')
  return { ...args, world: project }
}
