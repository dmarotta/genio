export interface EditorSeat { seat: number; token: string; release(): boolean }
export interface EditorHolder { seat: number; pid?: number; owner?: string; project?: string; at?: number }
export interface SeatRequest { owner: string; project?: string; cap?: number; pid?: number }
export function editorSeatsDir(data: string): string
export function defaultEditorCap(totalBytes?: number): number
export function editorCap(dir: string): number
export function editorHolders(dir: string): EditorHolder[]
export function tryAcquireEditor(dir: string, request: SeatRequest): EditorSeat | null
export function releaseEditor(dir: string, seat: number, token: string): boolean
export function acquireEditor(dir: string, request: SeatRequest & { waitMs?: number; pollMs?: number; onWait?(holders: EditorHolder[]): void }): Promise<(EditorSeat & { waitedMs: number }) | null>
