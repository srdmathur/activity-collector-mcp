export interface TokenStore {
  gitlab?: string | {
    access_token: string;
    refresh_token: string;
    created_at: number;
    expires_in?: number;
  };
  github?: string;
  google?: {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
  };
  outlook?: {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
  };
  // Azure DevOps holds settings only - no secret. The access token is minted
  // on demand from the Azure CLI and never persisted.
  azureDevops?: {
    organization: string;
    projects?: string[];
    tenant?: string;
  };
}

export interface GitLabActivity {
  date: Date;
  commits: Array<{
    message: string;
    project: string;
    branch: string;
  }>;
  mergeRequests: Array<{
    action: 'created' | 'reviewed' | 'approved' | 'commented' | 'closed' | 'merged';
    title: string;
    project: string;
    id?: number;
  }>;
  issues: Array<{
    action: 'commented' | 'status_changed' | 'assigned' | 'opened' | 'closed';
    title: string;
    project: string;
    id?: number;
    details?: string;
  }>;
}

export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  attendees?: number;
}

export interface AzureDevOpsActivity {
  date: Date;
  workItems: Array<{
    id: number;
    title: string;
    type: string;
    project: string;
    actions: Array<'created' | 'state_changed' | 'assigned' | 'commented' | 'field_changed'>;
    stateFrom?: string;
    stateTo?: string;
  }>;
  pullRequests: Array<{
    action: 'created' | 'completed' | 'abandoned' | 'reviewing';
    title: string;
    id: number;
    repository: string;
    project: string;
  }>;
  commits: Array<{
    message: string;
    repository: string;
    project: string;
    branch?: string;
  }>;
  /** Projects/repos actually swept, so a partial sweep is never silent. */
  scanned: {
    projects: string[];
    repositories: number;
    commitsSkipped: boolean;
  };
}

export interface DayActivity {
  date: Date;
  meetings: CalendarEvent[];
  gitlabActivity: GitLabActivity;
  description: string;
}

export interface TimesheetEntry {
  date: string;
  dayOfWeek: string;
  description: string;
  wordCount: number;
}

export interface Config {
  gitlab?: {
    url: string;
    token?: string;
  };
  github?: {
    token?: string;
  };
  google?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  outlook?: {
    clientId: string;
    clientSecret: string;
    tenantId: string;
    redirectUri: string;
  };
}
