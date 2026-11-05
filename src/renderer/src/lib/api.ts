import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AppState } from '@shared/types'

export const api = window.klara

export function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return api.invoke<T>(channel, ...args)
}

/** Subscribe to a main-process event for the lifetime of the component. */
export function useEvent<T = any>(channel: string, cb: (payload: T) => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => api.on(channel, (p) => ref.current(p)), [channel])
}

// ---- app state (settings, engine, permissions, recording, microphone) ----

let state: AppState | null = null
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

api.on('state', (s: AppState) => {
  state = s
  notify()
})
void invoke<AppState>('state').then((s) => {
  state = s
  notify()
})

export function useAppState(): AppState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state
  )
}

export function setSettings(patch: Partial<AppState['settings']>): Promise<unknown> {
  return invoke('settings:set', patch)
}
