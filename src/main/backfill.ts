import { SOURCE_LABEL } from '@shared/types'
import { matchEventChecked, matchVersion } from './calendar'
import { db } from './storage/db'
import { isGenericTitle } from './meetings/titles'
import { listMeetingFolders, readMeeting, renameMeetingFolder, writeMeeting } from './storage/files'
import { broadcast } from './windows'

/**
 * Titles that say nothing about the call: the recorder's default ("Zoom 14:30", "פגישה 09:00"), a
 * Meet code or a tab/app name ("abc-defg-hij", "Zoom Meeting", "Chat").
 */
const placeholder = (title: string | undefined): boolean => isGenericTitle(title, Object.values(SOURCE_LABEL))

let running = false

/**
 * Past recordings that were never matched to the calendar (the calendar wasn't connected, or the
 * event was added later): look each one up once. A match gives the meeting its calendar name
 * (unless the user renamed it) and the attendees. Recordings with no event are left for Claude
 * (the automatic summary names them and writes participants and scope through the MCP server).
 */
export async function matchPastMeetings(): Promise<void> {
  if (running) return
  running = true
  let matched = 0
  let checked = 0
  const version = matchVersion()
  try {
    for (const folder of listMeetingFolders()) {
      const m = readMeeting(folder)
      const meta = m?.meta
      if (!m || !meta || meta.status !== 'done') continue
      // Matched at its start, but a browser tab's placeholder kept the title ("abc-defg-hij"; before
      // 0.1.3 the tab title won over the event's): give it the event's title, no lookup needed.
      const ev = meta.calendarEvent
      if (ev?.title && meta.titleSource !== 'user' && meta.title !== ev.title && placeholder(meta.title)) {
        meta.title = ev.title
        meta.titleSource = 'calendar'
        meta.folder = renameMeetingFolder(meta.folder, meta)
        writeMeeting(meta.folder, meta, m.segments)
        db().indexMeeting(meta, m.segments)
        broadcast('meetings:changed', meta.id)
      }
      if (meta.calendarChecked === version) continue
      // Matched by an older, looser pass (titleSource "calendar"), or never matched: look it up (again).
      const redo = meta.titleSource === 'calendar'
      if (meta.calendarEvent && !redo) continue
      checked++
      const r = await matchEventChecked(new Date(meta.startedAt), meta).catch(() => ({ event: null, readable: false }))
      // No calendar could be read (no permission, helper down, Google link off): "no event" is unknown
      // here, so leave the meeting unstamped and untouched; it is looked up again on the next pass.
      if (!r.readable) continue
      const event = r.event
      meta.calendarChecked = version
      if (event) {
        matched++
        if (redo && meta.calendarEvent?.id !== event.id && event.attendees.length) meta.attendees = []
        meta.calendarEvent = event
        if (!meta.attendees?.length) meta.attendees = event.attendees
        if (meta.titleSource !== 'user' && (meta.titleSource === 'calendar' || meta.titleSource === 'claude' || placeholder(meta.title))) {
          meta.title = event.title
          meta.titleSource = 'calendar'
        }
      }
      // An empty lookup never erases what the meeting already has: its calendar title, event and
      // attendees stay (a calendar removed from view, a deleted invite or a half-read feed would
      // otherwise wipe good names). It is just stamped as checked.
      if (event) meta.folder = renameMeetingFolder(meta.folder, meta)
      writeMeeting(meta.folder, meta, m.segments)
      db().indexMeeting(meta, m.segments)
      if (event) broadcast('meetings:changed', meta.id)
    }
  } finally {
    running = false
  }
  if (checked) console.log(`calendar: looked up ${checked} past recordings, ${matched} matched an event`)
}
