/** Marker for the Gauntlet's managed test step; target and executable come from its config. */
export function unityTestCommand(_root: string, _relativeRoot = '.'): string {
  return 'genio-unity test --mode EditMode'
}
export function isLegacyUnityTest(command?: string): boolean {
  return !!command && /^Unity -batchmode -projectPath (?:\.|"[^"\r\n]+") -runTests -testPlatform EditMode -logFile -$/i.test(command)
}
export function isDefaultUnityTest(command?: string): boolean {
  if (command === unityTestCommand('')) return true
  return isLegacyUnityTest(command) || !!command && /^(?:"[^"\r\n]+[\\/]Editor[\\/]Unity\.exe"|'[^'\r\n]+[\\/](?:Editor[\\/]Unity|Unity\.app[\\/]Contents[\\/]MacOS[\\/]Unity)') -batchmode -projectPath (?:\.|"[^"\r\n]+"|'[^'\r\n]+') -runTests -testPlatform EditMode -logFile -$/.test(command)
}
