import { useEffect, useRef } from 'react'
import { mountWidget } from './mount'
import type { WidgetProps } from './Widget'

/** The widget as a React component, rendered exactly as on a host page (own shadow root and styles). */
export default function EmbeddedWidget({ eventId, apiBase, rpcUrl, programId }: WidgetProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = mountWidget(ref.current!, { eventId, apiBase, rpcUrl, programId })
    // Deferred: this cleanup can run while React is still rendering the parent tree.
    return () => void setTimeout(() => root.unmount())
  }, [eventId, apiBase, rpcUrl, programId])
  return <div ref={ref} style={{ width: '100%', maxWidth: 400 }} />
}
