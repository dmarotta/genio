import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { errText, toast } from '../store'

/** Copies the message source, preserving Markdown and line breaks. */
export function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(reset.current), [])

  if (!text) return null

  const copy = async (): Promise<void> => {
    setPending(true)
    setCopied(false)
    clearTimeout(reset.current)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      reset.current = setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      toast('error', 'Message not copied', errText(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <span className="msg-acts msg-copy-acts">
      <button type="button" className="msg-act msg-copy" title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Message copied' : 'Copy message'} disabled={pending} onClick={() => void copy()}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <span className="sr-only" role="status">{copied ? 'Message copied' : ''}</span>
    </span>
  )
}
