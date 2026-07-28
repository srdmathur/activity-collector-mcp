import { exec } from 'child_process';
import { AzureDevOpsActivity } from '../types/index.js';

/**
 * Azure DevOps activity via the Azure CLI.
 *
 * No PAT is created or stored. The Azure CLI is a pre-consented first-party
 * application in every Entra tenant, so `az login` works where a bespoke app
 * registration would be blocked. Tokens are minted on demand and held in memory
 * only.
 */

/** Well-known Azure DevOps resource id - stable across all tenants. */
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const API_VERSION = '7.1';
const AZ_TIMEOUT_MS = 60_000;
/** Refresh a little before real expiry so a long fetch cannot straddle it. */
const TOKEN_SKEW_MS = 120_000;
/** Azure DevOps rejects work-item batches larger than this. */
const WORKITEM_BATCH_SIZE = 200;

export interface AzureDevOpsSettings {
  organization: string;
  projects?: string[];
  tenant?: string;
}

export interface AzureDevOpsIdentity {
  id: string;
  displayName: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Pure mapping helpers. Separated from transport so they can be tested against
// fixture JSON with no network and no Azure CLI.
// ---------------------------------------------------------------------------

type WorkItemAction = AzureDevOpsActivity['workItems'][number]['actions'][number];

interface RawUpdate {
  revisedBy?: { id?: string };
  revisedDate?: string;
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
}

/**
 * Reduces a work item's revision history to what this user changed on this day.
 * Returns null when they did not touch it, so callers can drop the item.
 */
export function mapWorkItemUpdates(
  updates: RawUpdate[],
  myId: string,
  dayStart: Date,
  dayEnd: Date
): { actions: WorkItemAction[]; stateFrom?: string; stateTo?: string } | null {
  const actions = new Set<WorkItemAction>();
  let stateFrom: string | undefined;
  let stateTo: string | undefined;

  for (const update of updates ?? []) {
    if (update.revisedBy?.id !== myId) continue;

    // Azure DevOps stamps some synthetic revisions with year 9999; treat a
    // missing or unparseable date as "not on this day" rather than crashing.
    const revised = update.revisedDate ? new Date(update.revisedDate) : null;
    if (!revised || Number.isNaN(revised.getTime())) continue;
    if (revised < dayStart || revised >= dayEnd) continue;

    const fields = update.fields ?? {};

    if (fields['System.CreatedDate']) actions.add('created');

    const stateChange = fields['System.State'];
    if (stateChange) {
      actions.add('state_changed');
      // Keep the earliest oldValue and latest newValue across the day.
      if (stateFrom === undefined && typeof stateChange.oldValue === 'string') {
        stateFrom = stateChange.oldValue;
      }
      if (typeof stateChange.newValue === 'string') stateTo = stateChange.newValue;
    }

    if (fields['System.AssignedTo']) actions.add('assigned');
    if (fields['System.History']) actions.add('commented');

    const otherFieldTouched = Object.keys(fields).some(
      (f) =>
        ![
          'System.State',
          'System.AssignedTo',
          'System.History',
          'System.CreatedDate',
          'System.ChangedDate',
          'System.ChangedBy',
          'System.Rev',
          'System.RevisedDate',
          'System.AuthorizedDate',
          'System.AuthorizedAs',
          'System.Watermark',
        ].includes(f)
    );
    if (otherFieldTouched) actions.add('field_changed');
  }

  if (actions.size === 0) return null;
  return { actions: [...actions], stateFrom, stateTo };
}

interface RawPullRequest {
  pullRequestId?: number;
  title?: string;
  status?: string;
  creationDate?: string;
  closedDate?: string;
  createdBy?: { id?: string };
  repository?: { name?: string };
}

/**
 * Classifies pull requests by what happened to them on the target day.
 *
 * ponytail: reviewer-side activity is reported as 'reviewing' without a precise
 * timestamp, because the PR payload carries no per-vote date. Upgrade path is
 * fetching /pullRequests/{id}/threads per PR, at one extra call each.
 */
export function mapPullRequests(
  prs: RawPullRequest[],
  myId: string,
  dayStart: Date,
  dayEnd: Date,
  project: string,
  asReviewer = false
): AzureDevOpsActivity['pullRequests'] {
  const inDay = (value?: string): boolean => {
    if (!value) return false;
    const d = new Date(value);
    return !Number.isNaN(d.getTime()) && d >= dayStart && d < dayEnd;
  };

  const out: AzureDevOpsActivity['pullRequests'] = [];

  for (const pr of prs ?? []) {
    if (pr.pullRequestId === undefined) continue;

    const base = {
      title: pr.title ?? `PR ${pr.pullRequestId}`,
      id: pr.pullRequestId,
      repository: pr.repository?.name ?? 'unknown',
      project,
    };

    if (asReviewer) {
      // Only surface PRs that were actually active on the day, otherwise every
      // open PR a user reviews would appear on every single date.
      if (inDay(pr.creationDate) || inDay(pr.closedDate)) {
        out.push({ ...base, action: 'reviewing' });
      }
      continue;
    }

    if (pr.createdBy?.id !== myId) continue;

    if (inDay(pr.creationDate)) {
      out.push({ ...base, action: 'created' });
    }
    if (inDay(pr.closedDate)) {
      out.push({
        ...base,
        action: pr.status === 'abandoned' ? 'abandoned' : 'completed',
      });
    }
  }

  return out;
}

interface RawCommit {
  comment?: string;
  commitId?: string;
}

/**
 * @param seenCommitIds when supplied, commit ids already present are skipped.
 *   Repositories within a project can share history (mirrors, forks), and the
 *   per-repository commits endpoint would otherwise report one commit several
 *   times, inflating a timesheet summary.
 */
export function mapCommits(
  commits: RawCommit[],
  repository: string,
  project: string,
  seenCommitIds?: Set<string>
): AzureDevOpsActivity['commits'] {
  const out: AzureDevOpsActivity['commits'] = [];

  for (const c of commits ?? []) {
    if (!c || (!c.comment && !c.commitId)) continue;

    if (seenCommitIds && c.commitId) {
      if (seenCommitIds.has(c.commitId)) continue;
      seenCommitIds.add(c.commitId);
    }

    out.push({
      message: (c.comment ?? '').split('\n')[0].trim() || `commit ${c.commitId?.slice(0, 8)}`,
      repository,
      project,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Tenant ids reach the command line, so they are constrained to the character
 * set of a GUID or a domain name. Everything else passed to the CLI is a
 * literal, which keeps the Windows shell path below injection-free.
 */
export function isValidTenant(tenant: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(tenant);
}

function looksLikeMissingCli(detail: string): boolean {
  return /not recognized|not found|no such file/i.test(detail);
}

/**
 * Runs the Azure CLI through a shell.
 *
 * A shell is required rather than preferred: on Windows the CLI ships as az.cmd,
 * and Node >= 18.20 refuses to execFile a .cmd shim directly (CVE-2024-27980
 * hardening), failing with EINVAL. Passing one pre-built command string instead
 * of an args array also avoids DEP0190.
 *
 * Injection safety rests on every argument being a compile-time literal except
 * the tenant, which isValidTenant() has already restricted to GUID/domain
 * characters before it can reach here.
 */
function runAz(args: string[]): Promise<string> {
  const command = ['az', ...args.map(shellQuote)].join(' ');

  return new Promise((resolve, reject) => {
    exec(
      command,
      { timeout: AZ_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message || '').trim();
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || looksLikeMissingCli(detail)) {
            return reject(new Error('AZ_CLI_MISSING'));
          }
          return reject(new Error(detail || 'Azure CLI call failed'));
        }
        resolve(stdout.trim());
      }
    );
  });
}

/** Quotes only when needed, and never passes a quote character through. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._:/=-]+$/.test(value)) return value;
  return `"${value.replace(/["`$\\]/g, '')}"`;
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

/** Local YYYY-MM-DD, for WIQL fields stored with date precision. */
export function toWiqlDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function azSetupInstructions(): string {
  const install =
    process.platform === 'darwin'
      ? 'brew install azure-cli'
      : process.platform === 'win32'
        ? 'winget install Microsoft.AzureCLI'
        : 'see https://learn.microsoft.com/cli/azure/install-azure-cli-linux';
  return [
    'Azure DevOps access uses the Azure CLI, so no personal access token is needed.',
    '',
    `  1. Install the CLI:      ${install}`,
    '  2. Add the extension:   az extension add --name azure-devops',
    '  3. Sign in:             az login',
    '',
    'If your Azure DevOps account is in a different tenant than your default',
    'sign-in, use: az login --tenant <tenant-id>',
  ].join('\n');
}

export class AzureDevOpsIntegration {
  private settings: AzureDevOpsSettings | null = null;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private identity: AzureDevOpsIdentity | null = null;
  private projectCache: string[] | null = null;

  async initialize(settings: AzureDevOpsSettings): Promise<void> {
    if (settings.tenant && !isValidTenant(settings.tenant)) {
      throw new Error(
        `Invalid tenant "${settings.tenant}". Expected a tenant GUID or domain name.`
      );
    }
    this.settings = settings;
    // Reset per-connection state so re-configuring cannot serve stale identity.
    this.token = null;
    this.tokenExpiresAt = 0;
    this.identity = null;
    this.projectCache = null;
  }

  private requireSettings(): AzureDevOpsSettings {
    if (!this.settings?.organization) {
      throw new Error('Azure DevOps not configured. Use configure_azure_devops first.');
    }
    return this.settings;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_SKEW_MS) {
      return this.token;
    }

    const settings = this.requireSettings();
    const args = ['account', 'get-access-token', '--resource', ADO_RESOURCE, '-o', 'json'];
    if (settings.tenant) args.push('--tenant', settings.tenant);

    let raw: string;
    try {
      raw = await runAz(args);
    } catch (error: any) {
      if (error.message === 'AZ_CLI_MISSING') {
        throw new Error(`Azure CLI (az) not found on PATH.\n\n${azSetupInstructions()}`);
      }
      throw new Error(
        `Could not obtain an Azure DevOps token.\n${error.message}\n\n${azSetupInstructions()}`
      );
    }

    let parsed: { accessToken?: string; expiresOn?: string; expires_on?: number };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Azure CLI returned unparseable token output.');
    }

    if (!parsed.accessToken) {
      throw new Error('Azure CLI returned no access token.');
    }

    this.token = parsed.accessToken;
    // `expiresOn` is local-time without a zone; fall back to a conservative
    // window rather than trusting a parse that may yield NaN.
    const parsedExpiry = parsed.expiresOn ? new Date(parsed.expiresOn).getTime() : NaN;
    this.tokenExpiresAt = Number.isNaN(parsedExpiry) ? Date.now() + 30 * 60_000 : parsedExpiry;

    return this.token;
  }

  private async api<T>(
    path: string,
    init?: { method?: string; body?: unknown; apiVersion?: string }
  ): Promise<T> {
    const settings = this.requireSettings();
    const token = await this.getToken();
    const separator = path.includes('?') ? '&' : '?';
    const version = init?.apiVersion ?? API_VERSION;
    const url = `https://dev.azure.com/${encodeURIComponent(settings.organization)}${path}${separator}api-version=${version}`;

    const response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Azure DevOps rejected the token (HTTP ${response.status}) for organization "${settings.organization}".\n` +
          'The most common cause is a tenant mismatch: the token was minted for your default ' +
          `Azure sign-in, but this organization lives in a different tenant.\n` +
          (settings.tenant
            ? `Configured tenant: ${settings.tenant}\n`
            : 'No tenant configured - set one with configure_azure_devops if your org is in another tenant.\n') +
          'Check with: az account show'
      );
    }

    if (response.status === 404) {
      throw new Error(
        `Azure DevOps returned 404 for organization "${settings.organization}". ` +
          'Verify the organization name (the segment after dev.azure.com/ in your browser URL).'
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Azure DevOps HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    // Azure DevOps answers an unauthenticated request with an HTML sign-in page
    // and HTTP 200, so a non-JSON content type means auth silently failed.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(
        'Azure DevOps returned a non-JSON response, which usually means the token was not accepted. ' +
          'Try: az login'
      );
    }

    return (await response.json()) as T;
  }

  async getIdentity(): Promise<AzureDevOpsIdentity> {
    if (this.identity) return this.identity;

    // connectionData is still preview-only at 7.1 and rejects a bare "7.1",
    // unlike the wit/git endpoints which are GA at that version.
    const data = await this.api<{
      authenticatedUser?: {
        id?: string;
        providerDisplayName?: string;
        properties?: { Account?: { $value?: string } };
      };
    }>('/_apis/connectionData', { apiVersion: '7.1-preview' });

    const user = data.authenticatedUser;
    if (!user?.id) {
      throw new Error('Could not determine the authenticated Azure DevOps user.');
    }

    this.identity = {
      id: user.id,
      displayName: user.providerDisplayName ?? 'unknown',
      email: user.properties?.Account?.$value ?? '',
    };
    return this.identity;
  }

  async listProjects(): Promise<string[]> {
    if (this.projectCache) return this.projectCache;

    const data = await this.api<{ value?: Array<{ name?: string }> }>('/_apis/projects?$top=500');
    this.projectCache = (data.value ?? [])
      .map((p) => p.name)
      .filter((n): n is string => typeof n === 'string');
    return this.projectCache;
  }

  /** Validates configuration and reports what the credential can see. */
  async validate(): Promise<{ identity: AzureDevOpsIdentity; projects: string[] }> {
    const identity = await this.getIdentity();
    const projects = await this.listProjects();
    return { identity, projects };
  }

  private async resolveProjects(): Promise<string[]> {
    const settings = this.requireSettings();
    if (settings.projects?.length) return settings.projects;
    return this.listProjects();
  }

  async getActivityForDate(dateStr: string): Promise<AzureDevOpsActivity> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Date must be in YYYY-MM-DD format (e.g., "2025-12-01")');
    }

    const settings = this.requireSettings();
    const [year, month, day] = dateStr.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day + 1, 0, 0, 0);

    const identity = await this.getIdentity();
    const projects = await this.resolveProjects();

    const activity: AzureDevOpsActivity = {
      date: dayStart,
      workItems: [],
      pullRequests: [],
      commits: [],
      scanned: { projects, repositories: 0, commitsSkipped: false },
    };

    for (const project of projects) {
      // Each project is isolated: one inaccessible project must not sink the
      // whole day's fetch.
      try {
        await this.collectWorkItems(project, identity.id, dayStart, dayEnd, activity);
      } catch (error) {
        console.error(`Azure DevOps work items failed for ${project}:`, error);
      }

      try {
        await this.collectPullRequests(project, identity.id, dayStart, dayEnd, activity);
      } catch (error) {
        console.error(`Azure DevOps pull requests failed for ${project}:`, error);
      }

      try {
        await this.collectCommits(project, identity, dayStart, dayEnd, activity);
      } catch (error) {
        console.error(`Azure DevOps commits failed for ${project}:`, error);
      }
    }

    return activity;
  }

  private async collectWorkItems(
    project: string,
    myId: string,
    dayStart: Date,
    dayEnd: Date,
    activity: AzureDevOpsActivity
  ): Promise<void> {
    // System.ChangedDate can be configured with *date precision*, in which case
    // WIQL rejects any value carrying a time component. Date-only is therefore
    // mandatory, not a simplification.
    //
    // Date-only also means the server resolves the boundary in its own timezone,
    // which can differ from ours by up to a day. So widen the query by one day
    // either side and let mapWorkItemUpdates() do the exact filtering against
    // revisedDate. Costs a few extra rows, cannot silently miss any.
    const wiql = {
      query:
        'SELECT [System.Id] FROM WorkItems ' +
        `WHERE [System.ChangedBy] = @Me ` +
        `AND [System.ChangedDate] >= '${toWiqlDate(addDays(dayStart, -1))}' ` +
        `AND [System.ChangedDate] <= '${toWiqlDate(addDays(dayEnd, 1))}'`,
    };

    const result = await this.api<{ workItems?: Array<{ id?: number }> }>(
      `/${encodeURIComponent(project)}/_apis/wit/wiql`,
      { method: 'POST', body: wiql }
    );

    const ids = (result.workItems ?? [])
      .map((w) => w.id)
      .filter((id): id is number => typeof id === 'number');
    if (ids.length === 0) return;

    for (let offset = 0; offset < ids.length; offset += WORKITEM_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + WORKITEM_BATCH_SIZE);
      const fields = 'System.Id,System.Title,System.WorkItemType,System.TeamProject';
      const detail = await this.api<{
        value?: Array<{ id?: number; fields?: Record<string, unknown> }>;
      }>(`/_apis/wit/workitems?ids=${batch.join(',')}&fields=${fields}`);

      for (const item of detail.value ?? []) {
        if (item.id === undefined) continue;

        const updates = await this.api<{ value?: RawUpdate[] }>(
          `/_apis/wit/workItems/${item.id}/updates`
        );
        const mapped = mapWorkItemUpdates(updates.value ?? [], myId, dayStart, dayEnd);
        if (!mapped) continue;

        activity.workItems.push({
          id: item.id,
          title: String(item.fields?.['System.Title'] ?? `Work item ${item.id}`),
          type: String(item.fields?.['System.WorkItemType'] ?? 'unknown'),
          project: String(item.fields?.['System.TeamProject'] ?? project),
          actions: mapped.actions,
          stateFrom: mapped.stateFrom,
          stateTo: mapped.stateTo,
        });
      }
    }
  }

  private async collectPullRequests(
    project: string,
    myId: string,
    dayStart: Date,
    dayEnd: Date,
    activity: AzureDevOpsActivity
  ): Promise<void> {
    const base = `/${encodeURIComponent(project)}/_apis/git/pullrequests`;

    const created = await this.api<{ value?: RawPullRequest[] }>(
      `${base}?searchCriteria.creatorId=${myId}&searchCriteria.status=all&$top=200`
    );
    activity.pullRequests.push(
      ...mapPullRequests(created.value ?? [], myId, dayStart, dayEnd, project)
    );

    const reviewing = await this.api<{ value?: RawPullRequest[] }>(
      `${base}?searchCriteria.reviewerId=${myId}&searchCriteria.status=all&$top=200`
    );
    activity.pullRequests.push(
      ...mapPullRequests(reviewing.value ?? [], myId, dayStart, dayEnd, project, true)
    );
  }

  private async collectCommits(
    project: string,
    identity: AzureDevOpsIdentity,
    dayStart: Date,
    dayEnd: Date,
    activity: AzureDevOpsActivity
  ): Promise<void> {
    // Commit search matches on author alias/email. Without one we would return
    // every author's commits, so skip rather than report noise as the user's work.
    if (!identity.email) {
      activity.scanned.commitsSkipped = true;
      return;
    }

    const repos = await this.api<{ value?: Array<{ id?: string; name?: string }> }>(
      `/${encodeURIComponent(project)}/_apis/git/repositories`
    );

    const seenCommitIds = new Set<string>();

    for (const repo of repos.value ?? []) {
      if (!repo.id) continue;
      activity.scanned.repositories += 1;

      const query = [
        `searchCriteria.author=${encodeURIComponent(identity.email)}`,
        `searchCriteria.fromDate=${encodeURIComponent(dayStart.toISOString())}`,
        `searchCriteria.toDate=${encodeURIComponent(dayEnd.toISOString())}`,
        '$top=200',
      ].join('&');

      const commits = await this.api<{ value?: RawCommit[] }>(
        `/${encodeURIComponent(project)}/_apis/git/repositories/${repo.id}/commits?${query}`
      );
      activity.commits.push(
        ...mapCommits(commits.value ?? [], repo.name ?? repo.id, project, seenCommitIds)
      );
    }
  }
}
