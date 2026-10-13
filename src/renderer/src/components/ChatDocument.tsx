import { createContext, useContext } from 'react'

/** Portalled chat controls and overlays belong to the window displaying the chat. */
export const ChatDocument = createContext<Document | undefined>(undefined)
export function useChatDocument(): Document { return useContext(ChatDocument) ?? document }
