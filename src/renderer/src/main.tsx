import i18n from 'i18next'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import { en, he } from './lib/strings'
import { useAppState } from './lib/api'
import { Library } from './views/Library'
import { Live } from './views/Live'
import { Pill } from './views/Pill'
import './styles.css'

void i18n.use(initReactI18next).init({
  resources: { he: { translation: he }, en: { translation: en } },
  lng: 'he',
  fallbackLng: 'he',
  interpolation: { escapeValue: false }
})

const route = window.location.hash.replace(/^#\/?/, '').split('/')[0]

/** Applies UI language (and RTL) and the light/dark theme from settings. */
function useAppearance(): void {
  const app = useAppState()
  const lang = app?.settings.uiLanguage ?? 'he'
  const theme = app?.settings.theme ?? 'system'
  useEffect(() => {
    void i18n.changeLanguage(lang)
    document.documentElement.lang = lang
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr'
  }, [lang])
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches))
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

function App() {
  useAppearance()
  if (route === 'pill') return <Pill />
  if (route === 'live') return <Live />
  return <Library />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
