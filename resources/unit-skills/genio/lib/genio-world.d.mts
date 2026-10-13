export interface PlacementAsset { path: string; folder: string; kind: string; vendor?: boolean }
export interface PlacementInput {
  assets: PlacementAsset[]; kind: string; engine?: string; engineRoot?: string
  name?: string; hint?: string; config?: { folders?: Record<string, string> }; root?: string
}
export interface Convention { folder: string; count: number; style: string; numbered: boolean; extensions: string[]; examples: string[] }
export function conventionsOf(input: PlacementInput): Convention[]
export function suggestLocation(input: PlacementInput): {
  engine: string; engineRoot: string
  suggestions: { path: string; folder: string; confidence: number; reason: string; naming: string; examples: string[] }[]
  warnings: string[]
}
