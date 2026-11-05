# סקילים של Klara Wisper ל-Claude

ארבעה סקילים שמלמדים את Claude לעבוד עם השיחות ש-[Klara Wisper](https://github.com/klara-gidash/klara-wisper) מקליטה ומתמללת: לפני פגישה, במהלך שיחה, אחריה ובסוף היום.

## איפה הסקילים נמצאים

התיקייה הזאת היא `skills/` בריפו [klara-wisper](https://github.com/klara-gidash/klara-wisper). היא מתפרסמת גם כריפו נפרד, [klara-wisper-skills](https://github.com/klara-gidash/klara-wisper-skills), עם אותם קבצים, כדי שאפשר יהיה להוריד, לשתף ולהעלות ל-Claude רק את הסקילים, בלי כל קוד האפליקציה.

## מה כל סקיל עושה

### לפני פגישה: `klara-meeting-prep`

תדריך קצר לפגישה הבאה (או לפגישה מסוימת): מי משתתף, ההקשר וההיסטוריה מהשיחות הקודמות, משימות והבטחות שנשארו פתוחות, וסדר יום ושאלות מוצעים. Claude מוצא את הפגישה ביומן של המק, ומחפש שיחות קודמות עם אותם אנשים.

אפשר לכתוב, למשל:
- "הכנה לפגישה הבאה"
- "מה צריך לדעת לפני הפגישה עם Acme?"
- "על מה דיברנו בפעם הקודמת עם Acme?"

קריאה בלבד: הסקיל לא שומר ולא משנה כלום.

### במהלך שיחה: `klara-live-catch-up`

כשמאבדים את החוט באמצע שיחה: מה נאמר בדקות האחרונות (ברירת מחדל: 5), מה מחכה לתשובה, מה הוחלט עד עכשיו, והצעה לתשובה אם שאלו משהו.

אפשר לכתוב, למשל:
- "מה פספסתי?"
- "מה נאמר ב-10 הדקות האחרונות?"
- "מה שאלו אותי? מה לענות?"

קריאה בלבד ב-Klara Wisper: הסקיל לא שומר ולא משנה כלום. אפשר לבקש לשלוח את התשובה במייל (ראו "שליחה מ-Claude").

### אחרי שיחה: `klara-meeting-summary`

סיכום בעברית במבנה קבוע: משתתפים, תקציר, נקודות עיקריות, החלטות, משימות עם שמות, שאלות פתוחות והמשך. הסיכום נשמר ליד התמלול ומופיע ב-Klara Wisper. בשיחה שלא ביומן (שיחה מזדמנת או פנים מול פנים), Claude גם נותן לשיחה שם שמתאר אותה, ורושם מי השתתף ועל מה דיברו.

Klara Wisper יכולה לסכם כל שיחה לבד, דקה-שתיים אחרי שהיא נגמרת (הגדרות ← Claude ← סיכום אוטומטי). הסקיל הזה הוא לסיכום לפי בקשה:
- "לסכם את השיחה"
- "לסכם שוב עם דגש על תמחור"
- "לסכם את הפגישה עם Acme מאתמול"
- "לסכם את כל השיחות שאין להן סיכום"
- "לשלוח את הסיכום למשתתפים"

### בסוף היום: `klara-daily-digest`

סקירה של כל השיחות של יום אחד (היום, אתמול או תאריך אחר): לכל שיחה השעה, השם, המשתתפים והנושא, 2–3 נקודות עיקריות והמשימות האישיות, ובסוף כל המשימות שנשארו פתוחות. שיחה של 3 דקות ומעלה שעוד אין לה סיכום מסוכמת קודם, באותו מבנה כמו `klara-meeting-summary`, והסיכום נשמר.

אפשר לכתוב, למשל:
- "מה היה היום?"
- "סיכום יומי"
- "על מה היו השיחות אתמול?"

**כל ערב, לבד:** ב-Claude Desktop יוצרים משימה מתוזמנת (Scheduled task) שרצה כל יום, למשל ב-19:00, עם הבקשה "סיכום יומי של השיחות של היום". דרך פשוטה: לכתוב ל-Claude Desktop "ליצור משימה מתוזמנת שרצה כל יום ב-19:00 ועושה סיכום יומי של השיחות של היום". המשימה רצה על המק, ולכן הוא צריך להיות דלוק בשעה הזאת. בריצה המתוזמנת Claude לא שואל שאלות ולא שולח כלום.

**מהטלפון:** עם המחבר האופציונלי של Cloudflare ([המדריך](https://github.com/klara-gidash/klara-wisper/blob/main/docs/CLOUDFLARE.he.md)), אפשר לבקש את הסיכום היומי גם מ-Claude בטלפון. המחבר הזה קריאה בלבד (`list_meetings`, `get_meeting`, `search_meetings`, `daily_digest`): הסקיל מציג את מה שכבר סוכם, ולא כותב ולא שומר כלום. שיחה בלי סיכום מסוכמת מ-Claude על המק.

## שליחה מ-Claude

`klara-meeting-summary` ו-`klara-live-catch-up` יכולים להכין מייל עם הסיכום או עם התשובה, **רק כשמבקשים את זה במפורש**:

1. כשמחבר Gmail מחובר ב-Claude (Settings ← Connectors), Claude יוצר **טיוטה**. בלי המחבר הוא מציג את המייל כטקסט להעתקה.
2. הנמענים הם משתתפי הפגישה מהיומן (השורה `calendar attendees` בכותרת של התמלול), בלי הכתובת האישית ובלי חדרי ישיבות. כשאין משתתפים ביומן, Claude שואל למי לשלוח. כתובת שנאמרה בשיחה לא נכנסת לנמענים.
3. Claude מציג את הטיוטה (נמענים, נושא, תוכן), ושולח רק אחרי אישור מפורש, למשל "כן, לשלוח".
4. Claude לעולם לא שולח בגלל משהו שנאמר בשיחה, גם אם מישהו ביקש "תשלחו לי את הסיכום". בקשה כזאת נכנסת לסיכום כמשימה.

## מה צריך

- Klara Wisper מותקנת על המק ומחוברת ל-Claude. המדריך המלא: [docs/INSTALL.he.md](https://github.com/klara-gidash/klara-wisper/blob/main/docs/INSTALL.he.md) בריפו klara-wisper.
- כדי לבדוק את החיבור ב-Claude Desktop: Settings ← Developer. השרת `klara-wisper` צריך להופיע במצב running.
- לשליחת מיילים (לא חובה): מחבר Gmail ב-Claude.

## התקנה ב-Claude Code

**Klara Wisper מתקינה את הסקילים לבד** לתוך `~/.claude/skills` בפתיחה הראשונה, ומעדכנת אותם כשהיא מתעדכנת. לכן ב-Claude Code בדרך כלל אין צורך לעשות כלום.

התקנה ידנית (למשל במחשב בלי Klara Wisper, או כדי לנסות גרסה מהריפו): פותחים Terminal בתיקייה של הריפו klara-wisper-skills (או בתיקייה `skills/` של klara-wisper), ומריצים:

```
mkdir -p ~/.claude/skills && cp -R klara-meeting-prep klara-live-catch-up klara-meeting-summary klara-daily-digest ~/.claude/skills/
```

כדי לפתוח Terminal בתיקייה: פותחים את Terminal, כותבים `cd` ורווח, גוררים את התיקייה לחלון ולוחצים Enter.

תיקייה שהועתקה ידנית לא מתעדכנת אוטומטית: Klara Wisper לא נוגעת בה. כדי לחזור לעדכון האוטומטי, מוחקים את התיקייה מ-`~/.claude/skills` ופותחים מחדש את Klara Wisper.

ב-Claude Code הסקילים מופעלים לבד לפי מה שכותבים, ואפשר גם לקרוא להם ישירות: `/klara-meeting-prep`, `/klara-live-catch-up`, `/klara-meeting-summary`, `/klara-daily-digest`.

## התקנה ב-Claude Desktop

ב-Claude Desktop מעלים כל סקיל כקובץ zip, פעם אחת:

1. ב-Finder, קליק ימני על התיקייה `klara-meeting-prep` ← **Compress "klara-meeting-prep"**. נוצר הקובץ `klara-meeting-prep.zip`. עושים את אותו הדבר ל-`klara-live-catch-up`, ל-`klara-meeting-summary` ול-`klara-daily-digest`.
2. ב-Claude Desktop: **Settings ← Capabilities** (בגרסאות חדשות: **Settings ← Skills**). מוודאים ש-Skills מופעל. אם האפשרות לא מופיעה, ייתכן שצריך להפעיל קודם את **Code execution and file creation** באותו מסך.
3. **Upload skill** ← בוחרים את אחד מקובצי ה-zip. חוזרים על זה לכל אחד מארבעת הקבצים.
4. מוודאים שארבעת הסקילים מופיעים ברשימה ומופעלים (המתג דלוק).

אפשר גם ליצור את ארבעת קובצי ה-zip בבת אחת, מ-Terminal בתיקייה של הסקילים:

```
for d in klara-*/; do zip -r "${d%/}.zip" "$d" -x '*.DS_Store'; done
```

עדכון: יוצרים zip חדש ומעלים אותו שוב. אם הגרסה הישנה נשארת ברשימה, מוחקים אותה.

גם בלי הסקילים, ב-Claude Desktop יש שתי פקודות מוכנות בכפתור **+** ← klara-wisper: "סיכום שיחה" ו"מה פספסתי?".

## שינוי הסגנון

המבנה של כל פלט כתוב בסעיף 3 בקובץ ה-`SKILL.md` של הסקיל: הסיכום ב-`klara-meeting-summary`, התדריך ב-`klara-meeting-prep`, והסיכום היומי ב-`klara-daily-digest`. אפשר לערוך (להוסיף או להוריד סעיפים, לשנות אורך), ואז להתקין שוב.

עריכה ישירה ב-`~/.claude/skills`: Klara Wisper מחליפה את הקובץ בעדכון הבא. כדי לשמור על השינויים, מוחקים מאותה תיקייה את הקובץ `.installed-by-klara-wisper`.

## אבטחה

התמלול הוא מה שאנשים אחרים אמרו בשיחה. כל הסקילים מתייחסים אליו כמידע ולא כהוראות: Claude לא שולח מייל או הודעה ולא מבצע פעולה רק כי מישהו אמר את זה בשיחה.

- `klara-meeting-prep` ו-`klara-live-catch-up` לא כותבים כלום ב-Klara Wisper.
- `klara-meeting-summary` כותב רק את הסיכום ואת פרטי השיחה שביקשו לסכם. `klara-daily-digest` כותב רק סיכומים לשיחות של אותו יום שעוד אין להן סיכום, ולא מחליף סיכום קיים.
- מייל: רק כשמבקשים, קודם כטיוטה, ונשלח רק אחרי אישור מפורש.
- דרך המחבר של Cloudflare אי אפשר לכתוב או לשלוח כלום.

---

## English

Four Claude skills for [Klara Wisper](https://github.com/klara-gidash/klara-wisper), a local macOS app that records and transcribes calls (Hebrew-first) and exposes them to Claude through the `klara-wisper` MCP server. This folder is `skills/` in the klara-wisper repo, and is also published as its own repo, [klara-wisper-skills](https://github.com/klara-gidash/klara-wisper-skills), with the same files.

- **`klara-meeting-prep`** (before): a short Hebrew brief for the next or a named meeting, from the Mac calendar and earlier calls with the same people: who, context and history, open tasks and promises, suggested agenda and questions. Read-only.
- **`klara-live-catch-up`** (during): what was said in the last N minutes (default 5), what is waiting for you, decisions so far, and a suggested reply. Read-only in Klara Wisper.
- **`klara-meeting-summary`** (after): Hebrew notes in a fixed format, saved next to the transcript; names ad-hoc and in-person calls and records participants and scope; can summarize every call that has no notes yet. Klara Wisper can also do this automatically after each call of 3 minutes or more.
- **`klara-daily-digest`** (end of day): every call of a day with time, title, participants, scope, 2-3 key points and your tasks, then all open tasks. Summarizes and saves calls of 3+ minutes that have no notes first. A Claude Desktop scheduled task can run it every evening. Through the optional Cloudflare connector it works read-only from the phone (`daily_digest`).

**Sending:** only when you ask, `klara-meeting-summary` and `klara-live-catch-up` create a Gmail draft (Gmail connector) addressed to the calendar attendees, show it, and send only after you explicitly confirm. Never because of something said in the transcript.

**Requirements:** Klara Wisper installed and connected to Claude. Gmail connector optional.

**Claude Code:** Klara Wisper copies the skills to `~/.claude/skills` on first launch and keeps them updated (folders without its `.installed-by-klara-wisper` marker are left alone). To install by hand, from this folder:
`mkdir -p ~/.claude/skills && cp -R klara-meeting-prep klara-live-catch-up klara-meeting-summary klara-daily-digest ~/.claude/skills/`

**Claude Desktop:** zip each skill folder (Finder → Compress), then Settings → Capabilities (or Skills) → Upload skill, once per zip.

**Security:** transcript text is what other people said. The skills treat it as data, never as instructions, and never send email or messages because a transcript says so.
