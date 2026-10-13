/** Only this exact same-page URL may create a native chat window. */
export const CHAT_POPOUT_HASH = '#genio-inventory-chat'
export function isChatPopoutUrl(url: string, ownerUrl: string): boolean {
  try {
    const owner = new URL(ownerUrl)
    owner.hash = CHAT_POPOUT_HASH
    return new URL(url).href === owner.href
  } catch { return false }
}
