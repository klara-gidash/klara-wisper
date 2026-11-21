"""Writes a one-event .ics for the e2e tests (read by the app when KLARA_E2E=1 and
KLARA_E2E_ICS_FILE=<path>): a Google Meet call "בדיקת שיחה" from now-5 min to now+60 min.

    python make_ics.py <out.ics>
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone

TITLE = "בדיקת שיחה"
MEET = "https://meet.google.com/abc-defg-hij"


def stamp(dt: datetime) -> str:
    return dt.strftime("%Y%m%dT%H%M%SZ")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: make_ics.py <out.ics>")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Klara Wisper//e2e//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:{uuid.uuid4()}@klara-wisper-e2e",
        f"DTSTAMP:{stamp(now)}",
        f"DTSTART:{stamp(now - timedelta(minutes=5))}",
        f"DTEND:{stamp(now + timedelta(minutes=60))}",
        f"SUMMARY:{TITLE}",
        f"LOCATION:{MEET}",
        f"DESCRIPTION:Join with Google Meet: {MEET}",
        "X-GOOGLE-CONFERENCE:" + MEET,
        "ORGANIZER;CN=E2E:mailto:organizer@example.com",
        "ATTENDEE;CN=Tester;PARTSTAT=ACCEPTED:mailto:tester@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    # RFC 5545: CRLF line ends, UTF-8.
    with open(sys.argv[1], "w", encoding="utf-8", newline="") as f:
        f.write("\r\n".join(lines) + "\r\n")
    print(f"ok: wrote {sys.argv[1]} ({TITLE}, {stamp(now - timedelta(minutes=5))}..{stamp(now + timedelta(minutes=60))})")


if __name__ == "__main__":
    main()
