export interface DesktopWindow { hwnd: string; pid: number; process?: string; className?: string; title?: string; owner?: string; enabled?: boolean; rect?: number[]; texts?: string[]; buttons?: string[] }
export interface DesktopLaunchResult { ok: boolean; pid?: number; created?: string; desktop?: string; helper?: number; stage?: string; message?: string }
/** The Win32 primitives the helper executes; tests pass a fake. */
export interface DesktopApi {
  available(): boolean
  launch(options: { name: string; command: string; cwd: string; env?: NodeJS.ProcessEnv; dir: string; owner?: { pid: number; created: string }; visible?: boolean }): Promise<DesktopLaunchResult>
  windows(desktop: string): Promise<DesktopWindow[] | null>
  click(desktop: string, hwnd: string, button: string): Promise<boolean>
  screenshot(desktop: string, file: string): Promise<string | undefined>
  close(desktop: string, pid: number): Promise<boolean>
}
/** The identity a pool records for a launched slot editor. created is '' when unknown. */
export interface EditorLaunch { pid: number; created: string; hidden: boolean; desktop?: string; dir?: string; helper?: number; warning?: string }
export type SpawnVisible = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => Promise<number>
export interface DialogRule { id: string; kind: 'ignore' | 'benign' | 'blocking'; title?: RegExp; match?: RegExp; button?: string[]; reason?: string; immediate?: boolean }
export interface DialogBlock { hwnd: string; pid: number; process?: string; className?: string; title: string; text: string; buttons: string[]; rule: string; reason: string; screenshot?: string; message: string }
export interface InspectResult { watched: boolean; gone?: boolean; clicked: { title: string; button: string; rule: string }[]; blocked?: DialogBlock }
export const HELPER_SOURCE: string
export const DIALOG_RULES: DialogRule[]
export function hiddenDesktopDir(data: string): string
export function cscPath(env?: NodeJS.ProcessEnv): string | undefined
export function helperExecutable(data: string, options?: { source?: string; compiler?: string; compile?: (compiler: string, source: string, out: string) => Promise<void> }): Promise<string>
export function quoteArg(arg: string): string
export function windowsCommandLine(file: string, args: string[]): string
export function createDesktopApi(data: string, options?: { compiler?: string; compile?: (compiler: string, source: string, out: string) => Promise<void> }): DesktopApi
export function launchEditor(options: { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; data: string; visible?: boolean; label?: string; api?: DesktopApi; spawnVisible?: SpawnVisible; owner?: { pid: number; created: string } }): Promise<EditorLaunch>
export function classifyWindow(window: DesktopWindow, rules?: DialogRule[]): { kind: 'ignore' | 'benign' | 'blocking'; rule: string; button?: string; reason?: string; immediate?: boolean }
export function inspectDesktop(api: DesktopApi, launch: { desktop?: string; dir?: string } | undefined, options?: { now?: number; graceMs?: number; benignOnly?: boolean; rules?: DialogRule[] }): Promise<InspectResult>
