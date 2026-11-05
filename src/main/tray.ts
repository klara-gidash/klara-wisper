import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { audio } from './audio'
import { dictation } from './dictation'
import { recorder } from './meetings/recorder'
import { projectRoot } from './paths'
import { settings } from './settings'
import { showLibrary } from './windows'

let tray: Tray | null = null

function icon(name: string): Electron.NativeImage {
  const dir = app.isPackaged ? process.resourcesPath : join(projectRoot, 'resources')
  const img = nativeImage.createFromPath(join(dir, `${name}.png`))
  if (name.endsWith('Template')) img.setTemplateImage(true)
  return img
}

const he = (): boolean => settings.value.uiLanguage === 'he'
const t = (hebrew: string, english: string): string => (he() ? hebrew : english)

export function refreshTray(): void {
  if (!tray) return
  const live = recorder.live
  tray.setImage(icon(live && live.phase === 'recording' ? 'trayRecording' : 'trayTemplate'))
  tray.setToolTip(live ? `Klara Wisper · ${live.title}` : 'Klara Wisper')
  const micLabel = audio.current?.name ?? audio.devices.find((d) => d.uid === audio.pick())?.name ?? '—'
  const items: Electron.MenuItemConstructorOptions[] = []
  if (live) {
    items.push(
      { label: `${live.phase === 'recording' ? '● ' : ''}${live.title}`, enabled: false },
      {
        label: live.paused ? t('המשך הקלטה', 'Resume') : t('השהיה', 'Pause'),
        enabled: live.phase === 'recording',
        click: () => recorder.setPaused(!live.paused)
      },
      { label: t('עצירה ושמירה', 'Stop & save'), enabled: live.phase === 'recording', click: () => void recorder.stop() },
      { type: 'separator' }
    )
  } else {
    items.push(
      {
        label: t('התחלת פגישה פנים מול פנים', 'Start in-person meeting'),
        click: () => void recorder.start({ mode: 'inperson', source: 'inperson' }).catch(() => showLibrary())
      },
      { type: 'separator' }
    )
  }
  items.push(
    {
      label: dictation.publicState().phase === 'recording' ? t('סיום הכתבה', 'Finish dictation') : t('הכתבה', 'Dictate'),
      accelerator: 'Control+Alt+Space',
      click: () => dictation.toggle('shortcut')
    },
    { label: t('פתיחת הספרייה', 'Open library'), click: () => showLibrary() },
    { type: 'separator' },
    { label: `🎙 ${micLabel}${settings.value.micUid ? '' : t(' · אוטומטי', ' · auto')}`, enabled: false },
    {
      label: t('סריקת מיקרופונים (לדבר עכשיו)', 'Scan microphones (speak now)'),
      enabled: !audio.micBusy,
      click: () => void audio.scan().then(refreshTray, () => undefined)
    },
    {
      label: t('זיהוי שיחות אוטומטי', 'Auto-detect calls'),
      type: 'checkbox',
      checked: settings.value.autoRecord,
      click: (item) => settings.update({ autoRecord: item.checked })
    },
    { type: 'separator' },
    { label: t('הגדרות…', 'Settings…'), click: () => showLibrary('settings') },
    { label: t('יציאה', 'Quit'), role: 'quit' }
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

export function createTray(): Tray {
  tray = new Tray(icon('trayTemplate'))
  refreshTray()
  recorder.on('state', refreshTray)
  audio.on('devices', refreshTray)
  settings.on('change', refreshTray)
  return tray
}
