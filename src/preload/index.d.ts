import type { KlaraApi } from './index'

declare global {
  interface Window {
    klara: KlaraApi
  }
}

export {}
