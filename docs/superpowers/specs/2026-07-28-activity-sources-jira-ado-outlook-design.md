# Adding Jira, Azure DevOps, and Outlook activity sources

**Date:** 2026-07-28
**Status:** Approved, implemented
**Repos touched:** `activity-collector-mcp`, `timesheet-mcp`

## Goal

Add Jira, Azure DevOps, and Outlook as activity sources feeding timesheet
generation, alongside the existing GitLab and Google Calendar integrations.

## Hard constraint that shaped everything

**No user may be asked to create a token.** No API tokens, no personal access
tokens. Authentication must be either a browser consent flow or an existing CLI
sign-in.

A second constraint emerged during design: **an MCP server cannot call another
MCP server's tools.** `activity-collector-mcp` is a server, so "use the Atlassian
MCP for Jira" can only mean the LLM calls it directly, with no Jira code in this
server at all.

## Environment findings

These were measured, not assumed, and each one eliminated an option:

| Finding | How verified | Consequence |
|---|---|---|
| Jira is Cloud at `fashionuk.atlassian.net` | `getAccessibleAtlassianResources` | Cloud REST/JQL semantics apply |
| Azure CLI 2.88.0 present, `azure-devops` extension installed | `az version` | Zero ADO prerequisites on this machine |
| ADO token mints successfully | `az account get-access-token --resource 499b84ac-…` returned a Bearer token | ADO auth approach confirmed working |
| Azure CLI's Graph token has **no** `Calendars.*` scope | decoded `scp` claim from a Graph token | The az trick does not extend to calendar |
| Tenant user consent is `microsoft-user-default-low` | `policies/authorizationPolicy` | `Calendars.Read` is not low-impact, so users cannot self-consent |
| No tenant-wide `Calendars.*` grant for Graph CLI | `oauth2PermissionGrants` for the SP | `mgc` would fail without admin action |
| Account cannot list app registrations; only security-group memberships, incl. `PSI-Dev-External` | `az ad app list`, `me/memberOf` | App registration genuinely blocked (guest account) |
| Classic Outlook installed, COM registered | registry + `New-Object -ComObject` | Local COM bridge is viable |
| `UseNewOutlook = 1` | registry | New Outlook has no COM; must run classic |
| Machine timezone is India Standard Time (UTC+5:30) | `Get-TimeZone` | Local/UTC conversions must be read carefully when testing |

## Design

### Authentication

| Source | Mechanism | Stored secret | User action |
|---|---|---|---|
| Jira | Atlassian MCP (OAuth, browser) | none in this repo | Click Accept in browser |
| Azure DevOps | `az account get-access-token` | **none** | `az login` once |
| Outlook | local desktop automation | **none** | none |

### Azure DevOps — `src/integrations/azureDevOps.ts`

One shell-out per fetch mints a Bearer token for the well-known ADO resource id
`499b84ac-1321-427f-aa17-267ca6975798`; REST 7.1 calls then use plain `fetch`.
The Azure CLI is a pre-consented first-party application in every Entra tenant,
which is why it works where a bespoke app registration is blocked.

Tokens are held in memory with a 2-minute skew so a long fetch cannot straddle
expiry. Nothing is persisted. Settings only (`organization`, optional `projects`,
optional `tenant`) go to the token file.

Per day, per project:
- Work items: WIQL on `[System.ChangedBy] = @Me` and `[System.ChangedDate]`, then
  a batched work-item fetch (max 200 ids), then `/updates` per item to determine
  what actually changed and by whom.
- Pull requests: `git/pullrequests` by `creatorId`, then again by `reviewerId`.
- Commits: `git/repositories` per project, then `/commits` filtered by author
  email and date.

Each project is fetched inside its own try/catch so one inaccessible project
cannot sink the whole day.

`tenant` exists because the ADO account may live in a different tenant than the
default `az login`. A 401/403 returns an explicit tenant-mismatch explanation
rather than a bare status code. A 200 response with a non-JSON content type is
also treated as failure, because Azure DevOps answers unauthenticated requests
with an HTML sign-in page and HTTP 200.

### Outlook — `src/integrations/outlookLocal.ts`

Reads the already-signed-in desktop client, so there is no token, no consent, and
no Azure involvement.

- **Windows:** PowerShell → `Outlook.Application` COM. Three details are
  load-bearing: `Sort('[Start]')` must precede `IncludeRecurrences = $true` or
  recurring meetings are silently omitted; `Restrict()` parses dates in Windows
  regional format, so en-US `MM/dd/yyyy hh:mm tt` is generated explicitly; only
  `Recipients.Count` is read, never `.Address`, because addresses trip Outlook's
  programmatic-access guard and raise a modal dialog.
- **macOS:** `osascript -l JavaScript` against Outlook for Mac's
  `calendarEvents`, filtering in JS because `whose` support is inconsistent
  across versions.
- Other platforms throw a message naming the two escape hatches (publish an ICS
  URL; ask an admin to consent `Calendars.Read`).

Both bridges emit the same JSON, normalised by the exported `parseCalendarJson`,
which handles a JSON array, a bare object (PowerShell 5.1 unwraps single-element
collections), and empty stdout. All-day entries are filtered out, matching the
previous Graph integration's behaviour. A 60-second kill-timeout converts a modal
dialog into a legible error instead of a hang.

Requires **classic** Outlook on Windows. New Outlook is a web wrapper with no
automation surface.

### Jira — no code in this repo

Served by the Atlassian MCP, called directly by the LLM and orchestrated from
`timesheet-mcp`'s prompts. `check_authentication_status` prints the install
command unconditionally, because a server cannot see which other servers the
client has loaded.

Accepted costs: the Atlassian MCP exposes JQL search and issue read but no
changelog or worklog read, so per-day precision is "issues touched" rather than
"transitions and hours logged"; and Jira results are not cached, since this
server does not fetch them.

### Changes to existing code

Additive only, by explicit instruction — nothing restructured, no pre-existing
bugs fixed, no dead code removed, `outlookCalendar.ts` (Graph) left dormant.

- `types/index.ts`: `AzureDevOpsActivity`, plus `azureDevops` on `TokenStore`.
  `CalendarEvent` reused unchanged for Outlook.
- `tokenStorage.ts`: `getAzureDevOps` / `setAzureDevOps` / `hasAzureDevOps`.
- `cache.ts`: an `azureDevops` bucket copied from the existing per-source
  pattern. `load()` now defaults every bucket rather than trusting the file's
  shape, because cache files written before a bucket existed lack that key and
  would otherwise crash on access.
- `index.ts`: three new tools, their handlers, a shared `resolveDateArgs` helper,
  and an extended `check_authentication_status`.

**Zero new dependencies.** Node's global `fetch` and `child_process` only.

### Tool surface: 8 → 11

`configure_azure_devops`, `fetch_azure_devops_activity`,
`fetch_outlook_calendar_events`. `check_authentication_status` gains rows for
Outlook, Azure DevOps, and Jira, printing setup steps inline for whatever is not
ready. `clear_cache` accepts `azure_devops`.

The new fetch tools deliberately do not copy the GitLab handler's unconditional
raw-JSON debug dump.

### timesheet-mcp

The four orchestration prompts now reference the new sources and Jira via the
Atlassian MCP. References to `fetch_github_activity` were removed because that
tool does not exist — its handler is commented out in activity-collector, so
every run was burning a failed call. Hard-coded "make ONLY 3 tool calls" guidance
became "one call per configured service", since the source count is now variable.

## Verification

- `tsc` clean.
- 18 `node:test` assertions covering `parseCalendarJson` (array, bare object,
  empty, all-day filtering, non-JSON rejection), `mapWorkItemUpdates` (state
  transitions, other users, other days, bookkeeping-only revisions, malformed
  dates), `mapPullRequests` (created/completed/abandoned/reviewer modes), and
  `mapCommits`. All pass.
- Outlook verified end to end on Windows against a real appointment: created a
  throwaway event, read it back through the integration with correct title, time,
  and attendee count, then deleted it.
- Azure DevOps verified live against `fashion-uk` / `Design_Portal`: identity
  resolved, 3 pull requests and 7 commits returned for 2026-07-27, 1 PR and 6
  commits for 2026-07-24, 1 PR and 15 commits for 2026-07-23.

### Bugs found and fixed during live testing

Three defects only a live run could surface:

1. **`spawn EINVAL`.** Node >= 18.20 refuses to `execFile` a `.cmd`/`.bat` shim
   (CVE-2024-27980 hardening) and the Azure CLI on Windows is `az.cmd`. Earlier
   manual `az` calls worked only because they ran inside PowerShell. Fixed by
   running one pre-built command string through `exec`, which also avoids the
   `DEP0190` warning that `shell: true` plus an args array produces. Injection
   safety comes from `isValidTenant()`, since the tenant is the only
   non-literal argument.
2. **HTTP 400 on `connectionData`.** That endpoint treats `7.1` as preview and
   requires `7.1-preview`, unlike the `wit`/`git` endpoints which are GA at 7.1.
   Fixed with a per-call `apiVersion` override.
3. **HTTP 400 on WIQL.** `[System.ChangedDate]` is configured with *date
   precision* in this project, so WIQL rejects any value carrying a time:
   `"You cannot supply a time with the date when running a query using date
   precision"`. Every work-item query was failing while PRs and commits
   succeeded. Fixed by querying date-only and widening the range one day either
   side, with exact filtering left to `mapWorkItemUpdates()` against
   `revisedDate`.

Also added: commits are deduplicated by `commitId` within a day, because a
project's repositories can share history and the per-repository endpoint would
otherwise report one commit several times.

### What live testing could not exercise

- **ADO work items.** `Design_Portal` contains zero work items — verified with
  an unfiltered `SELECT [System.Id] FROM WorkItems`, which returns 0. The
  `DP-*` keys in commit messages are **Jira** issues (Jira project `DP`,
  "Fashion-UK Design Portal"), not ADO work items. The work-item code path is
  therefore correct-but-unexercised: WIQL succeeds and returns empty. It will
  stay empty for this project regardless of date.
- **Outlook real meetings.** The mailbox calendar is empty (134 inbox items, 0
  appointments). Verified instead with a synthetic appointment created and
  deleted.
- **macOS Outlook.** Written, never run.

## Known limits

- `ponytail:` Outlook `Restrict()` assumes en-US date parsing. If a locale
  rejects the filter, the upgrade path is to drop `Restrict` and filter
  client-side over a bounded window.
- `ponytail:` ADO reviewer-side pull requests are reported as `reviewing` with no
  precise timestamp, because the PR payload carries no per-vote date. Upgrade
  path is fetching `/pullRequests/{id}/threads`, one extra call per PR.
- Outlook macOS path is written but unverified; new Outlook for Mac removed much
  of the AppleScript surface.
- Commit fetching sweeps every visible project unless `projects` is configured.
  Tool output always reports how many projects and repositories were scanned, so
  a partial sweep is never silent.
- Commits are skipped when no account email resolves, rather than returning every
  author's commits as the user's work.
