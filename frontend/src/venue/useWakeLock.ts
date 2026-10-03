import { useEffect } from 'react'

/** Keeps the screen on while `active` (Screen Wake Lock API). Silently does nothing where unsupported. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false
    const acquire = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const l = await navigator.wakeLock.request('screen')
        if (cancelled) void l.release().catch(() => {})
        else lock = l
      } catch {
        // Not allowed (battery saver, iframe, …): the page still works, the screen may just dim.
      }
    }
    // The browser drops the lock whenever the page is hidden; take it again when we come back.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (!lock || lock.released)) void acquire()
    }
    void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => {})
    }
  }, [active])
}
