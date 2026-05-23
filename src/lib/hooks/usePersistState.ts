import { useState, useEffect, useRef, Dispatch, SetStateAction } from 'react'

/**
 * Drop-in replacement for useState that persists to localStorage.
 * On first render it reads the stored value; every subsequent state
 * change writes it back.  SSR-safe: localStorage is never touched on
 * the server.
 *
 * @param key     Unique localStorage key (use a stable, namespaced string)
 * @param initial Value to use when nothing is stored yet
 */
export function usePersistState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const raw = window.localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  // Track the key so we can clean up if it changes (rare, but safe)
  const keyRef = useRef(key)
  keyRef.current = key

  useEffect(() => {
    try {
      window.localStorage.setItem(keyRef.current, JSON.stringify(state))
    } catch {
      // Private-browsing / storage-full — fail silently
    }
  }, [state])

  return [state, setState]
}
