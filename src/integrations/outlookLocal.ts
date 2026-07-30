import { execFile } from 'child_process';
import { CalendarEvent } from '../types/index.js';

/**
 * Reads the local Outlook desktop calendar with no authentication at all.
 *
 * Why not Microsoft Graph: Graph needs delegated Calendars.Read, which is not a
 * low-impact scope. Tenants that set user consent to "low impact only" therefore
 * require an admin grant, and app registration is commonly blocked for guest
 * accounts. Reading the already-signed-in desktop client sidesteps both.
 */

const EXEC_TIMEOUT_MS = 60_000;

/** Shape emitted by both the PowerShell and JXA bridges. */
interface RawEvent {
  subject?: string | null;
  start?: string | null;
  end?: string | null;
  attendees?: number | null;
  allDay?: boolean | null;
}

/**
 * Normalises bridge stdout into CalendarEvent[].
 *
 * Handles three shapes that both bridges can produce:
 *  - a JSON array (many events)
 *  - a bare JSON object (PowerShell's ConvertTo-Json unwraps single-element
 *    collections in 5.1, so one event arrives without brackets)
 *  - empty/whitespace stdout (no events matched)
 *
 * Exported for tests: this is the parsing logic most likely to regress.
 */
export function parseCalendarJson(stdout: string): CalendarEvent[] {
  const trimmed = (stdout ?? '').trim();
  if (trimmed === '' || trimmed === 'null') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Calendar bridge returned non-JSON output: ${trimmed.slice(0, 200)}`);
  }

  if (parsed === null) {
    return [];
  }

  const raw: RawEvent[] = Array.isArray(parsed) ? parsed : [parsed as RawEvent];

  return raw
    // All-day entries are holidays/OOF markers, not worked meetings. The Graph
    // integration filtered these out too, so behaviour stays consistent.
    .filter((e) => e && !e.allDay && e.start && e.end)
    .map((e) => ({
      title: e.subject?.trim() || 'Untitled Event',
      start: new Date(e.start as string),
      end: new Date(e.end as string),
      attendees: typeof e.attendees === 'number' ? e.attendees : 0,
    }));
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // A timeout means the host app is showing a modal dialog and will
          // never return. Say so, rather than surfacing a bare kill signal.
          if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
            return reject(
              new Error(
                `Outlook did not respond within ${EXEC_TIMEOUT_MS / 1000}s. ` +
                  'It may be showing a dialog (security prompt, password request, or a restart notice). ' +
                  'Open Outlook, clear any prompt, then retry.'
              )
            );
          }
          return reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ''}`));
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Outlook's Restrict() parses date strings using the *Windows regional format*,
 * not ISO. en-US "MM/dd/yyyy hh:mm tt" is what virtually every published sample
 * uses and is accepted broadly.
 *
 * ponytail: assumes Restrict accepts en-US dates. If a non-en-US locale rejects
 * the filter, upgrade path is to drop Restrict and filter client-side over a
 * bounded window (slower, locale-proof).
 */
function formatForRestrict(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${mm}/${dd}/${yyyy} ${String(h).padStart(2, '0')}:${min} ${ampm}`;
}

function buildPowerShellScript(dayStart: Date, dayEnd: Date): string {
  const filter = `[Start] >= '${formatForRestrict(dayStart)}' AND [Start] < '${formatForRestrict(dayEnd)}'`;

  // Ordering below is load-bearing: Sort('[Start]') MUST precede
  // IncludeRecurrences = $true, or recurring meetings are silently omitted.
  // Only Recipients.Count is read - touching Recipients[].Address trips
  // Outlook's programmatic-access guard and pops a dialog.
  return `
$ErrorActionPreference = 'Stop'
$outlook = New-Object -ComObject Outlook.Application
$items = $outlook.GetNamespace('MAPI').GetDefaultFolder(9).Items
$items.Sort('[Start]')
$items.IncludeRecurrences = $true
$found = $items.Restrict("${filter.replace(/"/g, '`"')}")
$result = New-Object System.Collections.ArrayList
foreach ($appt in $found) {
  $null = $result.Add([pscustomobject]@{
    subject   = $appt.Subject
    start     = $appt.Start.ToString('yyyy-MM-ddTHH:mm:ss')
    end       = $appt.End.ToString('yyyy-MM-ddTHH:mm:ss')
    attendees = $appt.Recipients.Count
    allDay    = [bool]$appt.AllDayEvent
  })
}
ConvertTo-Json -InputObject @($result.ToArray()) -Depth 3 -Compress
`.trim();
}

function buildJxaScript(dayStart: Date, dayEnd: Date): string {
  // Outlook for Mac exposes calendarEvents via JXA. Filtering happens in JS
  // because Outlook's `whose` clause support is inconsistent across versions.
  return `
const startMs = ${dayStart.getTime()};
const endMs = ${dayEnd.getTime()};
const outlook = Application('Microsoft Outlook');
outlook.includeStandardAdditions = true;
const out = [];
const events = outlook.calendarEvents();
for (let i = 0; i < events.length; i++) {
  const ev = events[i];
  let s, e;
  try { s = ev.startTime(); e = ev.endTime(); } catch (err) { continue; }
  if (!s || !e) continue;
  const sMs = s.getTime();
  if (sMs < startMs || sMs >= endMs) continue;
  let attendees = 0;
  try { attendees = ev.attendees().length; } catch (err) { attendees = 0; }
  let allDay = false;
  try { allDay = !!ev.allDayFlag(); } catch (err) { allDay = false; }
  out.push({
    subject: ev.subject(),
    start: s.toISOString(),
    end: e.toISOString(),
    attendees: attendees,
    allDay: allDay
  });
}
JSON.stringify(out);
`.trim();
}

export class OutlookLocalIntegration {
  /** True when this platform has a supported local bridge. */
  static isSupported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin';
  }

  static unsupportedMessage(): string {
    return (
      `Local Outlook access is not available on platform "${process.platform}". ` +
      'Supported: Windows (Outlook desktop via COM) and macOS (Outlook for Mac via AppleScript).\n\n' +
      'Alternatives on other platforms:\n' +
      '  1. Publish your calendar as an ICS URL (Outlook Web > Settings > Calendar > Shared calendars > Publish)\n' +
      '  2. Ask an administrator to grant Calendars.Read consent, then use Microsoft Graph'
    );
  }

  async getEventsForDate(dateStr: string): Promise<CalendarEvent[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Date must be in YYYY-MM-DD format (e.g., "2025-12-01")');
    }

    if (!OutlookLocalIntegration.isSupported()) {
      throw new Error(OutlookLocalIntegration.unsupportedMessage());
    }

    const [year, month, day] = dateStr.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day + 1, 0, 0, 0);

    if (process.platform === 'win32') {
      const stdout = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildPowerShellScript(dayStart, dayEnd),
      ]).catch((err) => {
        throw new Error(
          `Could not read the local Outlook calendar.\n${err.message}\n\n` +
            'Check that classic Outlook desktop is installed and has your mailbox configured. ' +
            'The "new Outlook" app does not expose COM automation.'
        );
      });
      return parseCalendarJson(stdout);
    }

    // macOS. Unverified against the rewritten "new Outlook for Mac", which
    // removed much of the AppleScript surface - hence the explicit guidance.
    const stdout = await run('osascript', ['-l', 'JavaScript', '-e', buildJxaScript(dayStart, dayEnd)]).catch(
      (err) => {
        throw new Error(
          `Could not read Outlook for Mac.\n${err.message}\n\n` +
            'Likely causes: (1) the automation permission prompt was not granted - ' +
            'check System Settings > Privacy & Security > Automation; ' +
            '(2) you are running the new Outlook for Mac, which removed AppleScript calendar support.\n\n' +
            OutlookLocalIntegration.unsupportedMessage()
        );
      }
    );
    return parseCalendarJson(stdout);
  }
}
