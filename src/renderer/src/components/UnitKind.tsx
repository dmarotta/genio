import { Box, Radar, Rocket, Sparkles } from 'lucide-react'
import type { TaskKind } from '@shared/types'

type Kinded = { kind: TaskKind; modeller?: boolean; generator?: boolean }

/** A unit's kind icon: Recon radar, Modeller box, Generator sparkles, Build rocket. */
export function UnitKindIcon({ t, size }: { t: Kinded; size: number }) {
  if (t.kind === 'scout') return <Radar size={size} />
  return t.modeller ? <Box size={size} /> : t.generator ? <Sparkles size={size} /> : <Rocket size={size} />
}

/** The kind chip's color class: violet Recon, orange Modeller, magenta Generator, neon Build. */
export const unitKindChip = (t: Kinded): 'violet' | 'orange' | 'magenta' | 'neon' =>
  t.kind === 'scout' ? 'violet' : t.modeller ? 'orange' : t.generator ? 'magenta' : 'neon'
