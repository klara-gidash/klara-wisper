import { dialog, shell } from 'electron'
import { settings } from './settings'

const PANE = process.platform === 'win32' ? 'ms-settings:privacy-microphone' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

export const isMicDenied = (err: unknown): boolean => /microphone permission denied/i.test(String((err as Error)?.message ?? err))

/** Explains the blocked microphone in plain words and offers to open the right Settings pane. */
export async function explainMicDenied(): Promise<void> {
  const he = settings.value.uiLanguage === 'he'
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: [he ? 'פתיחת הגדרות המיקרופון' : 'Open Microphone Settings', he ? 'סגירה' : 'Close'],
    defaultId: 0,
    cancelId: 1,
    message: he ? 'אין ל-Klara Wisper גישה למיקרופון' : 'Klara Wisper can’t use the microphone',
    detail: he
      ? 'בהגדרות המערכת > פרטיות ואבטחה > מיקרופון, צריך להפעיל את המתג של Klara Wisper ואז לנסות שוב.'
      : 'In System Settings > Privacy & Security > Microphone, turn on Klara Wisper, then try again.'
  })
  if (response === 0) void shell.openExternal(PANE)
}
