"""Client file ("תיק לקוח מצטבר"): groups meetings by client or person and reads the open tasks and
decisions out of saved summaries. Pure functions over meta.json dicts and summary.md text.

The same rules as src/shared/clients.ts (the app's Clients page); keep the two in step:
- Company: the calendar attendees' email domain (registrable part: eu.acme.com -> acme.com,
  mail.shikun.co.il -> shikun.co.il), minus the user's own domain (colleagues) and personal mail.
- Person: an attendee on personal mail or without an email, and the people Claude identified in a call
  that has no calendar attendees (in person, ad hoc).
- Title words: a meeting whose title names a client (the domain's name, or a word that is in the titles of
  2+ of that client's meetings and in nobody else's) joins that client too.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

GENERIC_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.il", "ymail.com", "hotmail.com", "hotmail.co.il",
    "outlook.com", "outlook.co.il", "live.com", "live.co.il", "msn.com", "icloud.com", "me.com", "mac.com",
    "aol.com", "walla.co.il", "walla.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
    "mail.com", "yandex.com", "yandex.ru", "zoho.com", "bezeqint.net", "netvision.net.il", "012.net.il",
    "inter.net.il", "smile.net.il", "zahav.net.il",
})
RESOURCE = re.compile(r"(^|\.)(resource|group)\.calendar\.google\.com$|(^|\.)calendar\.google\.com$")
STOPWORDS = frozenset({
    "meeting", "call", "sync", "weekly", "daily", "monthly", "intro", "introduction", "demo", "review", "with", "and",
    "the", "for", "about", "update", "updates", "kickoff", "kick", "off", "follow", "followup", "check", "catch",
    "zoom", "meet", "teams", "google", "slack", "huddle", "chat", "session", "discussion", "planning", "status",
    "onboarding", "training", "team", "quick", "touch", "base", "connect", "next", "steps", "new", "via", "from",
    "פגישה", "פגישת", "שיחה", "שיחת", "שיחות", "פגישות", "עם", "על", "של", "את", "בין", "לבין", "אצל", "סטטוס",
    "הכרות", "היכרות", "דמו", "הדגמה", "סנכרון", "שבועית", "שבועי", "חודשית", "חודשי", "יומי", "יומית", "עדכון",
    "המשך", "הצגה", "תיאום", "הכנה", "לקראת", "סיכום", "בנושא", "נושא", "קצרה", "קצר", "ראשונה", "חדש", "חדשה",
    "צוות", "הדרכה", "הטמעה", "מעקב", "זום", "טלפון", "טלפונית", "פנים", "מול",
})
COMPOUND_SLD = frozenset({"co", "com", "org", "net", "ac", "gov", "edu", "muni", "k12", "ltd", "plc"})
PLACEHOLDER = re.compile(r"^((משתתף|משתתפת|דובר|דוברת|speaker|participant|rem|spk)\s*\d*|אני|me|לא ידוע|unknown)$", re.IGNORECASE)
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def normalize_text(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = re.sub(r"[֑-ׇ̀-ͯ]", "", s)
    return re.sub(r"\s+", " ", s.lower()).strip()


def words_of(s: str | None) -> list[str]:
    return [w for w in re.split(r"[\W_]+", normalize_text(s)) if w]


def title_words(title: str | None) -> list[str]:
    out: list[str] = []
    for w in words_of(title):
        if len(w) >= 3 and w not in STOPWORDS and not w.isdigit() and w not in out:
            out.append(w)
    return out


def registrable_domain(email_or_domain: str | None) -> str:
    host = (email_or_domain or "").strip().lower().split("@")[-1].rstrip(".")
    if not host or "." not in host or not re.fullmatch(r"[a-z0-9.-]+", host):
        return ""
    if RESOURCE.search(host):
        return host
    labels = host.split(".")
    n = len(labels)
    take = 3 if n >= 3 and len(labels[-1]) == 2 and labels[-2] in COMPOUND_SLD else 2
    return ".".join(labels[-take:])


def company_name(domain: str) -> str:
    return " ".join(w[:1].upper() + w[1:] for w in re.split(r"[-_]+", domain.split(".")[0]) if w)


def clean_name(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def attendees_of(m: dict) -> list[dict]:
    return m.get("attendees") or (m.get("calendarEvent") or {}).get("attendees") or []


def own_domains(meetings: list[dict], extra: list[str] | None = None) -> set[str]:
    out: set[str] = set()

    def add(d: str) -> None:
        if d and d not in GENERIC_DOMAINS and not RESOURCE.search(d):
            out.add(d)

    for d in extra or []:
        add(registrable_domain(d))
    for m in meetings:
        for a in attendees_of(m):
            if a.get("isMe") and "@" in (a.get("email") or ""):
                add(registrable_domain(a["email"]))
        cal = (m.get("calendarEvent") or {}).get("calendar") or ""
        if EMAIL.match(cal):
            add(registrable_domain(cal))
    return out


@dataclass
class Client:
    key: str
    kind: str  # "company" | "person"
    name: str
    domain: str | None
    aliases: list[str] = field(default_factory=list)
    people: list[str] = field(default_factory=list)
    meeting_ids: list[str] = field(default_factory=list)  # newest first
    last_at: str = ""

    @property
    def count(self) -> int:
        return len(self.meeting_ids)


def group_clients(meetings: list[dict], own: list[str] | None = None, user_name: str | None = None) -> list[Client]:
    """Clients (companies and people), most recent first. Each meeting dict is a meta.json."""
    domains = own_domains(meetings, own)
    me = normalize_text(user_name)
    by_id = {m["id"]: m for m in meetings if m.get("id")}
    drafts: dict[str, dict] = {}

    def draft(key: str, kind: str, name: str, domain: str | None) -> dict:
        if key not in drafts:
            drafts[key] = {"key": key, "kind": kind, "name": name, "domain": domain, "people": {}, "direct": set(), "all": set()}
        return drafts[key]

    def add_person(d: dict, name: str, email: str) -> None:
        pid = (email or normalize_text(name)).lower()
        if pid and pid not in d["people"]:
            d["people"][pid] = f"{name} <{email}>" if name and email else name or email

    def is_me_or_placeholder(label: str) -> bool:
        return bool(PLACEHOLDER.match(label.strip())) or bool(me and normalize_text(label) == me)

    # 1. Attendees.
    for m in by_id.values():
        anyone = False
        for a in attendees_of(m):
            if a.get("isMe"):
                continue
            email = (a.get("email") or "").strip().lower()
            name = clean_name(a.get("name"))
            domain = registrable_domain(email) if "@" in email else ""
            if domain and RESOURCE.search(domain):
                continue
            anyone = True
            if domain and domain in domains:
                continue  # a colleague
            if domain and domain not in GENERIC_DOMAINS:
                d = draft(domain, "company", company_name(domain), domain)
                d["direct"].add(m["id"])
                add_person(d, name, email)
            else:
                label = name or email.split("@")[0]
                if not label or is_me_or_placeholder(label):
                    continue
                d = draft(f"person:{normalize_text(label)}", "person", label, None)
                d["direct"].add(m["id"])
                add_person(d, name, email)
        if not anyone:
            for raw in m.get("inferredParticipants") or []:
                label = clean_name(raw)
                if not label or is_me_or_placeholder(label):
                    continue
                d = draft(f"person:{normalize_text(label)}", "person", label, None)
                d["direct"].add(m["id"])
                add_person(d, label, "")

    # 2. Title words that belong to one company.
    def titles_of(m: dict) -> list[str]:
        seen: list[str] = []
        for w in title_words(m.get("title")) + title_words((m.get("calendarEvent") or {}).get("title")):
            if w not in seen:
                seen.append(w)
        return seen

    owners: dict[str, set[str]] = {}
    counts: dict[str, dict[str, int]] = {}
    for d in drafts.values():
        c: dict[str, int] = {}
        for mid in d["direct"]:
            for w in titles_of(by_id[mid]):
                c[w] = c.get(w, 0) + 1
        counts[d["key"]] = c
        for w in c:
            owners.setdefault(w, set()).add(d["key"])
    mine = set(title_words(user_name))
    aliases: dict[str, list[str]] = {}
    for d in drafts.values():
        if d["kind"] != "company":
            continue
        label = normalize_text(d["domain"].split(".")[0])
        found = [label] if len(label) >= 3 and label not in STOPWORDS else []
        for w, n in counts[d["key"]].items():
            if n >= 2 and len(owners[w]) == 1 and w not in mine and w not in found:
                found.append(w)
        aliases[d["key"]] = found

    # 3. Title matches.
    for m in by_id.values():
        words = set(titles_of(m))
        both = (m.get("title") or "") + " " + ((m.get("calendarEvent") or {}).get("title") or "")
        title = " " + " ".join(words_of(both)) + " "
        for d in drafts.values():
            if m["id"] in d["direct"]:
                continue
            if d["kind"] == "company":
                if any(w in words for w in aliases.get(d["key"], [])):
                    d["all"].add(m["id"])
            else:
                full = " ".join(words_of(d["name"]))
                if " " in full and f" {full} " in title:
                    d["all"].add(m["id"])

    out: list[Client] = []
    for d in drafts.values():
        ids = sorted(d["direct"] | d["all"], key=lambda i: by_id[i].get("startedAt", ""), reverse=True)
        if not ids:
            continue
        label = normalize_text(d["domain"].split(".")[0]) if d["domain"] else ""
        out.append(Client(
            key=d["key"], kind=d["kind"], name=d["name"], domain=d["domain"],
            aliases=[w for w in aliases.get(d["key"], []) if w != label],
            people=list(d["people"].values()), meeting_ids=ids, last_at=by_id[ids[0]].get("startedAt", ""),
        ))
    out.sort(key=lambda c: (c.last_at, c.count), reverse=True)
    return out


def find_clients(clients: list[Client], query: str) -> list[Client]:
    """Clients matching a name, domain, key or title word; an exact match wins over partial ones."""
    q = normalize_text(query).removeprefix("person:")
    if not q:
        return []
    qd = registrable_domain(q) if "." in q else ""
    exact, partial = [], []
    for c in clients:
        name = normalize_text(c.name)
        keys = {name, normalize_text(c.key).removeprefix("person:"), *(c.aliases)}
        if c.domain:
            keys |= {c.domain, normalize_text(c.domain.split(".")[0])}
        if q in keys or (qd and qd == c.domain):
            exact.append(c)
        elif q in name or any(q in normalize_text(p) for p in c.people) or (len(q) >= 3 and any(a.startswith(q) for a in c.aliases)):
            partial.append(c)
    return exact or partial


# ---- summary.md ----

HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
TASKS = re.compile(r"^(משימות|tasks|action items|next actions|to-?dos?)(?![^\W_])", re.IGNORECASE)
DECISIONS = re.compile(r"^(החלטות|decisions)(?![^\W_])", re.IGNORECASE)
GIST = re.compile(r"^(תקציר|סיכום|summary|tl;?dr|overview)(?![^\W_])", re.IGNORECASE)
NO_DECISIONS = re.compile(r"^(לא התקבלו החלטות|אין החלטות|no decisions)", re.IGNORECASE)
NONE = re.compile(r"^(אין|none|—|-)\.?$", re.IGNORECASE)
BULLET = re.compile(r"^(?:[-*•+]|\d+[.)])\s+(.*)$")


def clean_inline(s: str) -> str:
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"__(.+?)__", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def digest_summary(md: str | None, gist_limit: int = 240) -> dict:
    """{"gist", "open_tasks", "decisions"} from a saved summary (Hebrew or English headings)."""
    section = "top"
    gist: list[str] = []
    top: list[str] = []
    tasks: list[str] = []
    decisions: list[str] = []
    fence = seen_heading = False
    for raw in (md or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if re.match(r"^\s*(```|~~~)", raw):
            fence = not fence
        if fence:
            continue
        if h := HEADING.match(raw):
            title = clean_inline(h[2])
            if len(h[1]) == 1 and not seen_heading:
                section = "top"  # "# <title> — <date>"
            elif TASKS.match(title):
                section = "tasks"
            elif DECISIONS.match(title):
                section = "decisions"
            elif GIST.match(title):
                section = "gist"
            else:
                section = "other" if top or section != "top" else "top"
            seen_heading = True
            continue
        line = raw.strip()
        if not line:
            continue
        bullet = BULLET.match(line)
        if section == "tasks" and bullet:
            box = re.match(r"^\[( |x|X)\]\s*(.*)$", bullet[1])
            if box and box[1] != " ":
                continue
            text = clean_inline(box[2] if box else bullet[1])
            if text and not NONE.match(text):
                tasks.append(text)
        elif section == "decisions" and bullet:
            text = clean_inline(bullet[1])
            if text and not NO_DECISIONS.match(text) and not NONE.match(text):
                decisions.append(text)
        elif section == "gist":
            gist.append(clean_inline(bullet[1] if bullet else line))
        elif section == "top" and not re.match(r"^\*\*[^*]+:\*\*", line) and line != "---":
            top.append(clean_inline(bullet[1] if bullet else line))
    text = " ".join(gist or top)
    if len(text) > gist_limit:
        text = text[: gist_limit - 1].rstrip() + "…"
    return {"gist": text, "open_tasks": tasks, "decisions": decisions}
