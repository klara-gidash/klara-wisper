import { SOURCE_LABEL } from '@shared/types'
import { matchEventChecked, matchVersion } from './calendar'
import { db } from './storage/db'
import { listMeetingFolders, readMeeting, renameMeetingFolder, writeMeeting } from './storage/files'
import { broadcast } from './windows'

/** Titles the recorder gives when it knows nothing better ("Zoom 14:30", "פגישה 09:00"). */
const DEFAULT_TITLE = new RegExp(`^(?:פגישה|${Object.values(SOURCE_LABEL).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}) \\d{1,2}:\\d{2}$`)

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
      if (!m || !meta || meta.status !== 'done' || meta.calendarChecked === version) continue
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
        if (meta.titleSource !== 'user' && (meta.titleSource === 'calendar' || meta.titleSource === 'claude' || DEFAULT_TITLE.test(meta.title) || !meta.title)) {
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
