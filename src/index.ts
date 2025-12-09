#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { GitLabIntegration } from './integrations/gitlab.js';
import { GitHubIntegration } from './integrations/github.js';
import { GoogleCalendarIntegration } from './integrations/googleCalendar.js';
import { OutlookCalendarIntegration } from './integrations/outlookCalendar.js';
import { TokenStorage } from './utils/tokenStorage.js';
import { ActivityCache } from './utils/cache.js';
import { Config, DayActivity } from './types/index.js';
import { runOAuthFlow } from './utils/oauthFlow.js';
import { GitLabOAuth } from './utils/gitlabOAuth.js';
import { BUNDLED_OAUTH_CREDENTIALS, OAUTH_SCOPES } from './config/oauth.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

const CONFIG_FILE = path.join(homedir(), '.activity-collector-mcp-config.json');

class ActivityCollectorMCPServer {
  private server: Server;
  private gitlab: GitLabIntegration;
  private github: GitHubIntegration;
  private googleCalendar: GoogleCalendarIntegration;
  private outlookCalendar: OutlookCalendarIntegration;
  private tokenStorage: TokenStorage;
  private activityCache: ActivityCache;
  private config: Config | null = null;

  // Helper to send progress notifications to the client
  private async sendProgress(message: string, level: 'debug' | 'info' | 'warning' | 'error' = 'info'): Promise<void> {
    // Always log to stderr so it appears in MCP server logs
    console.error(`[${level.toUpperCase()}] ${message}`);

    try {
      // Also try to send as MCP logging message
      await this.server.sendLoggingMessage({
        level,
        logger: 'activity-collector-mcp',
        data: message,
      });
    } catch (error) {
      // Silently fail if notifications aren't supported
      // Already logged to stderr above
    }
  }

  constructor() {
    this.server = new Server(
      {
        name: 'activity-collector-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.gitlab = new GitLabIntegration();
    this.github = new GitHubIntegration();
    this.googleCalendar = new GoogleCalendarIntegration();
    this.outlookCalendar = new OutlookCalendarIntegration();
    this.tokenStorage = new TokenStorage();
    this.activityCache = new ActivityCache();

    this.setupHandlers();
  }

  private async loadConfig(): Promise<Config> {
    if (this.config) return this.config;

    try {
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      this.config = JSON.parse(data);
    } catch (error) {
      // Config file is optional - use defaults and bundled OAuth credentials
      this.config = {};
    }

    return this.config!;
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        // Outlook temporarily disabled
        // {
        //   name: 'configure_outlook_calendar',
        //   description: 'Start Outlook Calendar OAuth flow. Returns authorization URL.',
        //   inputSchema: {
        //     type: 'object',
        //     properties: {},
        //   },
        // },
        // {
        //   name: 'outlook_calendar_callback',
        //   description: 'Complete Outlook Calendar OAuth flow with authorization code.',
        //   inputSchema: {
        //     type: 'object',
        //     properties: {
        //       code: {
        //         type: 'string',
        //         description: 'Authorization code from OAuth callback',
        //       },
        //     },
        //     required: ['code'],
        //   },
        // },
        {
          name: 'check_authentication_status',
          description: 'Check which services are currently authenticated.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'authenticate_google',
          description: 'Authenticate with Google Calendar using automated OAuth flow. Opens browser automatically, captures authorization, and saves tokens. No manual code copying needed!',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'authenticate_gitlab',
          description: 'Authenticate with GitLab using automated OAuth flow. Opens browser automatically, captures authorization, and saves tokens. No manual code copying needed!',
          inputSchema: {
            type: 'object',
            properties: {
              gitlab_url: {
                type: 'string',
                description: 'GitLab instance URL (optional, defaults to https://gitlab.com)',
              },
            },
          },
        },
        {
          name: 'fetch_gitlab_activity',
          description: 'Fetch GitLab activity (commits, MRs) for a single date OR a date range. Fast tool that returns immediately. Use this for building custom timesheets.',
          inputSchema: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: 'Single date in YYYY-MM-DD format (e.g., "2025-11-27"). Use this OR start_date/end_date, not both.',
              },
              start_date: {
                type: 'string',
                description: 'Start date for range in YYYY-MM-DD format (e.g., "2025-12-01"). Must be used with end_date.',
              },
              end_date: {
                type: 'string',
                description: 'End date for range in YYYY-MM-DD format (e.g., "2025-12-05"). Must be used with start_date.',
              },
              force_refresh: {
                type: 'boolean',
                description: 'Optional. Bypass cache and fetch fresh data. Default: false.',
              },
            },
          },
        },
        // GitHub temporarily disabled
        // {
        //   name: 'fetch_github_activity',
        //   description: 'Fetch GitHub activity (commits, PRs) for a single date OR a date range. Fast tool that returns immediately. Use this for building custom timesheets.',
        //   inputSchema: {
        //     type: 'object',
        //     properties: {
        //       date: {
        //         type: 'string',
        //         description: 'Single date in YYYY-MM-DD format (e.g., "2025-11-27"). Use this OR start_date/end_date, not both.',
        //       },
        //       start_date: {
        //         type: 'string',
        //         description: 'Start date for range in YYYY-MM-DD format (e.g., "2025-12-01"). Must be used with end_date.',
        //       },
        //       end_date: {
        //         type: 'string',
        //         description: 'End date for range in YYYY-MM-DD format (e.g., "2025-12-05"). Must be used with start_date.',
        //       },
        //       force_refresh: {
        //         type: 'boolean',
        //         description: 'Optional. Bypass cache and fetch fresh data. Default: false.',
        //       },
        //     },
        //   },
        // },
        {
          name: 'fetch_google_calendar_events',
          description: 'Fetch Google Calendar events for a single date OR a date range. Fast tool that returns immediately. Use this for building custom timesheets.',
          inputSchema: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: 'Single date in YYYY-MM-DD format (e.g., "2025-11-27"). Use this OR start_date/end_date, not both.',
              },
              start_date: {
                type: 'string',
                description: 'Start date for range in YYYY-MM-DD format (e.g., "2025-12-01"). Must be used with end_date.',
              },
              end_date: {
                type: 'string',
                description: 'End date for range in YYYY-MM-DD format (e.g., "2025-12-05"). Must be used with start_date.',
              },
              force_refresh: {
                type: 'boolean',
                description: 'Optional. Bypass cache and fetch fresh data. Default: false.',
              },
            },
          },
        },
        // Outlook temporarily disabled
        // {
        //   name: 'fetch_outlook_calendar_events',
        //   description: 'Fetch Outlook Calendar events for a single date OR a date range. Fast tool that returns immediately. Use this for building custom timesheets.',
        //   inputSchema: {
        //     type: 'object',
        //     properties: {
        //       date: {
        //         type: 'string',
        //         description: 'Single date in YYYY-MM-DD format (e.g., "2025-11-27"). Use this OR start_date/end_date, not both.',
        //       },
        //       start_date: {
        //         type: 'string',
        //         description: 'Start date for range in YYYY-MM-DD format (e.g., "2025-12-01"). Must be used with end_date.',
        //       },
        //       end_date: {
        //         type: 'string',
        //         description: 'End date for range in YYYY-MM-DD format (e.g., "2025-12-05"). Must be used with start_date.',
        //       },
        //       force_refresh: {
        //         type: 'boolean',
        //         description: 'Optional. Bypass cache and fetch fresh data. Default: false.',
        //       },
        //     },
        //   },
        // },
        {
          name: 'clear_cache',
          description: 'Clear cached timesheet data. Useful when you want to force fresh data fetch for all future requests.',
          inputSchema: {
            type: 'object',
            properties: {
              scope: {
                type: 'string',
                description:
                  'Optional. What to clear: "all" (everything), "gitlab", "calendars", or "expired" (only expired entries). Default: "all".',
              },
            },
          },
        },
      ];

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'check_authentication_status':
            return await this.handleCheckAuthStatus();

          case 'authenticate_google':
            return await this.handleAuthenticateGoogle();

          case 'authenticate_gitlab':
            return await this.handleAuthenticateGitLab(request.params.arguments);

          case 'fetch_gitlab_activity':
            return await this.handleFetchGitLabActivity(request.params.arguments);

          // GitHub temporarily disabled
          // case 'fetch_github_activity':
          //   return await this.handleFetchGitHubActivity(request.params.arguments);

          case 'fetch_google_calendar_events':
            return await this.handleFetchGoogleCalendarEvents(request.params.arguments);

          // Outlook temporarily disabled
          // case 'fetch_outlook_calendar_events':
          //   return await this.handleFetchOutlookCalendarEvents(request.params.arguments);

          case 'clear_cache':
            return await this.handleClearCache(request.params.arguments);

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  private async handleCheckAuthStatus() {
    await this.tokenStorage.load();

    const status = {
      gitlab: this.tokenStorage.hasGitLabToken(),
      google: this.tokenStorage.hasGoogleTokens(),
    };

    const message = `Authentication Status:
- GitLab: ${status.gitlab ? '✓ Configured' : '✗ Not configured'}
- Google Calendar: ${status.google ? '✓ Configured' : '✗ Not configured'}

Note: Use authenticate_google or authenticate_gitlab for easy setup!`;

    return {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
    };
  }

  private async handleAuthenticateGoogle() {
    try {
      await this.sendProgress('Starting Google Calendar authentication...');

      // Load config to check for custom OAuth credentials
      let clientId = BUNDLED_OAUTH_CREDENTIALS.google.clientId;
      let clientSecret = BUNDLED_OAUTH_CREDENTIALS.google.clientSecret;

      try {
        const config = await this.loadConfig();
        if (config.google?.clientId && config.google?.clientSecret) {
          clientId = config.google.clientId;
          clientSecret = config.google.clientSecret;
          await this.sendProgress('Using custom OAuth credentials from config');
        } else {
          await this.sendProgress('Using bundled OAuth credentials');
        }
      } catch (error) {
        // Config file not found, use bundled credentials
        await this.sendProgress('Using bundled OAuth credentials');
      }

      // Run OAuth flow with auto-capture
      await this.sendProgress('Starting OAuth server...');

      const result = await runOAuthFlow((redirectUri) => {
        // Create OAuth2 client to generate auth URL
        const tempOAuth2Client = new (require('google-auth-library').OAuth2)(
          clientId,
          clientSecret,
          redirectUri
        );

        return tempOAuth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: OAUTH_SCOPES.google.calendar,
          prompt: 'consent',
        });
      });

      if (result.error) {
        throw new Error(`OAuth failed: ${result.error}`);
      }

      if (!result.code) {
        throw new Error('No authorization code received');
      }

      await this.sendProgress('Authorization code received, exchanging for tokens...');

      // Exchange code for tokens
      const redirectUri = `http://localhost:${result.port}/callback`;
      await this.googleCalendar.initialize(clientId, clientSecret, redirectUri);
      const tokens = await this.googleCalendar.setAuthorizationCode(result.code);

      // Save tokens
      await this.tokenStorage.load();
      await this.tokenStorage.setGoogleTokens(tokens);
      await this.sendProgress('Tokens saved successfully!');

      return {
        content: [
          {
            type: 'text',
            text: `✅ Successfully authenticated with Google Calendar!

Your access token has been saved and will be automatically refreshed when needed.
You can now use fetch_google_calendar_events to retrieve calendar data.`,
          },
        ],
      };
    } catch (error: any) {
      await this.sendProgress(`Authentication failed: ${error.message}`, 'error');
      return {
        content: [
          {
            type: 'text',
            text: `❌ Google Calendar authentication failed: ${error.message}

Please try again. If the problem persists, check that:
1. Your browser allows opening localhost URLs
2. Ports 8080-8090 are not all blocked by firewall
3. You authorized the application in the browser`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleAuthenticateGitLab(args: any) {
    try {
      const gitlabUrl = args?.gitlab_url || 'https://gitlab.com';

      await this.sendProgress(`Starting GitLab authentication for ${gitlabUrl}...`);

      // Get OAuth credentials
      const applicationId = BUNDLED_OAUTH_CREDENTIALS.gitlab.applicationId;
      const secret = BUNDLED_OAUTH_CREDENTIALS.gitlab.secret;

      await this.sendProgress('Using bundled OAuth credentials');

      // Create GitLab OAuth helper
      const gitlabOAuth = new GitLabOAuth({
        applicationId,
        secret,
        gitlabUrl,
      });

      // Run OAuth flow with auto-capture
      await this.sendProgress('Starting OAuth server...');

      const result = await runOAuthFlow((redirectUri) => {
        return gitlabOAuth.getAuthUrl(redirectUri, OAUTH_SCOPES.gitlab.api);
      });

      if (result.error) {
        throw new Error(`OAuth failed: ${result.error}`);
      }

      if (!result.code) {
        throw new Error('No authorization code received');
      }

      await this.sendProgress('Authorization code received, exchanging for tokens...');

      // Exchange code for tokens
      const redirectUri = `http://localhost:${result.port}/callback`;
      const tokens = await gitlabOAuth.getTokenFromCode(result.code, redirectUri);

      // Save tokens
      await this.tokenStorage.load();
      await this.tokenStorage.setGitLabOAuthTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        created_at: tokens.created_at,
        expires_in: tokens.expires_in,
      });
      await this.sendProgress('Tokens saved successfully!');

      // Initialize GitLab integration
      await this.gitlab.initialize(tokens.access_token, gitlabUrl);

      return {
        content: [
          {
            type: 'text',
            text: `✅ Successfully authenticated with GitLab (${gitlabUrl})!

Your access token has been saved and will be automatically refreshed when needed.
You can now use fetch_gitlab_activity to retrieve your GitLab activity.`,
          },
        ],
      };
    } catch (error: any) {
      await this.sendProgress(`Authentication failed: ${error.message}`, 'error');
      return {
        content: [
          {
            type: 'text',
            text: `❌ GitLab authentication failed: ${error.message}

Please try again. If the problem persists, check that:
1. Your browser allows opening localhost URLs
2. Ports 8080-8090 are not all blocked by firewall
3. You authorized the application in the browser
4. The GitLab URL is correct (${args?.gitlab_url || 'https://gitlab.com'})`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleClearCache(args: any) {
    await this.activityCache.load();
    const scope = args?.scope || 'all';

    let message = '';
    switch (scope.toLowerCase()) {
      case 'gitlab':
        await this.activityCache.clearGitLab();
        message = 'GitLab cache cleared successfully.';
        break;
      case 'calendars':
        await this.activityCache.clearCalendars();
        message = 'Calendar caches cleared successfully.';
        break;
      case 'expired':
        await this.activityCache.clearExpired();
        message = 'Expired cache entries cleared successfully.';
        break;
      case 'all':
      default:
        await this.activityCache.clearAll();
        message = 'All caches cleared successfully.';
        break;
    }

    const info = this.activityCache.getCacheInfo();
    message += `\n\nCache Status:\n- GitLab entries: ${info.gitlabEntries}\n- Google Calendar entries: ${info.googleCalendarEntries}\n- Outlook Calendar entries: ${info.outlookCalendarEntries}`;

    return {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
    };
  }

  // Fast granular fetch methods for building custom timesheets
  private async handleFetchGitLabActivity(args: any) {
    await this.tokenStorage.load();
    await this.activityCache.load();
    const config = await this.loadConfig();

    const gitlabToken = this.tokenStorage.getGitLabToken();
    if (!gitlabToken) {
      throw new Error('GitLab not configured. Please use configure_gitlab tool first.');
    }

    // Check if date range is provided
    if (args.start_date && args.end_date) {
      // Handle date range
      return this.handleFetchGitLabActivityRange(args, gitlabToken, config);
    } else if (args.date) {
      // Handle single date
      return this.handleFetchGitLabActivitySingle(args, gitlabToken, config);
    } else {
      throw new Error('Either date OR start_date+end_date must be provided');
    }
  }

  private async handleFetchGitLabActivitySingle(args: any, gitlabToken: string, config: any) {
    // Validate date format
    const dateStr = args.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    // Parse date to check if it's in the future
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (date > today) {
      return {
        content: [
          {
            type: 'text',
            text: `⚠️ Cannot fetch GitLab activity for future date ${dateStr}\n\n**Commits (0):**\n  (none - future date)\n\n**Merge Requests (0):**\n  (none - future date)\n\n**Issues (0):**\n  (none - future date)\n\nℹ️ Git activity can only be fetched for past and present dates.`,
          },
        ],
      };
    }

    await this.gitlab.initialize(gitlabToken, config.gitlab?.url || 'https://gitlab.com');

    const forceRefresh = args?.force_refresh ?? false;
    const { activity, fromCache } = await this.fetchGitLabActivityWithCache(dateStr, forceRefresh);
    const cacheIndicator = fromCache ? '📋 (from cache)' : '🔄 (fresh)';

    // Get debug info from GitLab integration
    const debugInfo = this.gitlab.debugInfo;

    // Format commits
    const commitsText = activity.commits.length > 0
      ? activity.commits.map((c: any) => `  - ${c.message} (${c.project})`).join('\n')
      : '  (none)';

    // Format MRs
    const mrsText = activity.mergeRequests.length > 0
      ? activity.mergeRequests.map((mr: any) => `  - ${mr.action}: ${mr.title} (#${mr.id}) in ${mr.project}`).join('\n')
      : '  (none)';

    // Format issues
    const issuesText = activity.issues.length > 0
      ? activity.issues.map((issue: any) => `  - ${issue.action}: ${issue.title} (#${issue.id}) in ${issue.project}`).join('\n')
      : '  (none)';

    // Format debug info
    const debugText = debugInfo ? `

🔍 **DEBUG INFO:**
\`\`\`json
${JSON.stringify(debugInfo, null, 2)}
\`\`\`` : '';

    return {
      content: [
        {
          type: 'text',
          text: `✅ GitLab activity fetched for ${dateStr} ${cacheIndicator}

**Commits (${activity.commits.length}):**
${commitsText}

**Merge Requests (${activity.mergeRequests.length}):**
${mrsText}

**Issues (${activity.issues.length}):**
${issuesText}${debugText}`,
        },
      ],
    };
  }

  private async handleFetchGitLabActivityRange(args: any, gitlabToken: string, config: any) {
    // Validate date formats
    const startDateStr = args.start_date;
    const endDateStr = args.end_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    // Parse dates
    const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
    const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
    const startDate = new Date(startYear, startMonth - 1, startDay);
    const endDate = new Date(endYear, endMonth - 1, endDay);

    // Validate range
    if (startDate > endDate) {
      throw new Error('start_date must be before or equal to end_date');
    }

    await this.gitlab.initialize(gitlabToken, config.gitlab?.url || 'https://gitlab.com');

    const forceRefresh = args?.force_refresh ?? false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Loop through all dates in range and fetch activity
    const allActivities: { [date: string]: any } = {};
    let totalCommits = 0;
    let totalMRs = 0;
    let totalIssues = 0;
    let cacheHits = 0;
    let freshFetches = 0;

    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;

      // Skip future dates
      if (currentDate > today) {
        allActivities[dateStr] = {
          date: new Date(currentDate),
          commits: [],
          mergeRequests: [],
          issues: [],
          isFuture: true,
        };
      } else {
        const { activity, fromCache } = await this.fetchGitLabActivityWithCache(dateStr, forceRefresh);
        allActivities[dateStr] = activity;
        totalCommits += activity.commits.length;
        totalMRs += activity.mergeRequests.length;
        totalIssues += activity.issues.length;
        if (fromCache) cacheHits++;
        else freshFetches++;
      }

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Format output grouped by date
    const dateEntries = Object.entries(allActivities)
      .map(([dateStr, activity]) => {
        if (activity.isFuture) {
          return `📅 **${dateStr}** (future date)\n  - No activity (future date)`;
        }

        if (activity.commits.length === 0 && activity.mergeRequests.length === 0 && activity.issues.length === 0) {
          return `📅 **${dateStr}**\n  - No activity`;
        }

        let details = `📅 **${dateStr}**\n\n`;

        // Format commits with details
        if (activity.commits.length > 0) {
          details += `**Commits (${activity.commits.length}):**\n`;
          details += activity.commits.map((c: any) => `  - ${c.message} (${c.project})`).join('\n');
          details += '\n\n';
        }

        // Format MRs with details
        if (activity.mergeRequests.length > 0) {
          details += `**Merge Requests (${activity.mergeRequests.length}):**\n`;
          details += activity.mergeRequests.map((mr: any) => `  - ${mr.action}: ${mr.title} (#${mr.id}) in ${mr.project}`).join('\n');
          details += '\n\n';
        }

        // Format issues with details
        if (activity.issues.length > 0) {
          details += `**Issues (${activity.issues.length}):**\n`;
          details += activity.issues.map((issue: any) => `  - ${issue.action}: ${issue.title} (#${issue.id}) in ${issue.project}`).join('\n');
        }

        return details.trim();
      })
      .join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

    const cacheInfo = cacheHits > 0 || freshFetches > 0
      ? `📋 Cache: ${cacheHits} hit${cacheHits !== 1 ? 's' : ''}, ${freshFetches} fresh fetch${freshFetches !== 1 ? 'es' : ''}`
      : '';

    // Get debug info from GitLab integration
    const debugInfo = this.gitlab.debugInfo;
    const debugText = debugInfo ? `

🔍 **DEBUG INFO:**
\`\`\`json
${JSON.stringify(debugInfo, null, 2)}
\`\`\`

📊 **RAW ACTIVITY DATA:**
\`\`\`json
${JSON.stringify(allActivities, null, 2)}
\`\`\`` : '';

    return {
      content: [
        {
          type: 'text',
          text: `✅ GitLab activity fetched for ${startDateStr} to ${endDateStr}

**Summary:**
- Total Commits: ${totalCommits}
- Total Merge Requests: ${totalMRs}
- Total Issues: ${totalIssues}
${cacheInfo}

**Activity by Date:**
${dateEntries}${debugText}`,
        },
      ],
    };
  }

  private async handleFetchGitHubActivity(args: any) {
    await this.tokenStorage.load();
    await this.activityCache.load();

    const githubToken = this.tokenStorage.getGitHubToken();
    if (!githubToken) {
      throw new Error('GitHub not configured. Please use configure_github tool first.');
    }

    // Check if date range is provided
    if (args.start_date && args.end_date) {
      // Handle date range
      return this.handleFetchGitHubActivityRange(args, githubToken);
    } else if (args.date) {
      // Handle single date
      return this.handleFetchGitHubActivitySingle(args, githubToken);
    } else {
      throw new Error('Either date OR start_date+end_date must be provided');
    }
  }

  private async handleFetchGitHubActivitySingle(args: any, githubToken: string) {
    // Validate date format
    const dateStr = args.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    // Parse date to check if it's in the future
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (date > today) {
      return {
        content: [
          {
            type: 'text',
            text: `⚠️ Cannot fetch GitHub activity for future date ${dateStr}\n\n**Commits (0):**\n  (none - future date)\n\n**Pull Requests (0):**\n  (none - future date)\n\n**Issues (0):**\n  (none - future date)\n\nℹ️ Git activity can only be fetched for past and present dates.`,
          },
        ],
      };
    }

    await this.github.initialize(githubToken);

    const forceRefresh = args?.force_refresh ?? false;
    const { activity, fromCache } = await this.fetchGitHubActivityWithCache(dateStr, forceRefresh);
    const cacheIndicator = fromCache ? '📋 (from cache)' : '🔄 (fresh)';

    // Format commits
    const commitsText = activity.commits.length > 0
      ? activity.commits.map((c: any) => `  - ${c.message} (${c.project})`).join('\n')
      : '  (none)';

    // Format PRs
    const prsText = activity.mergeRequests.length > 0
      ? activity.mergeRequests.map((pr: any) => `  - ${pr.action}: ${pr.title} (#${pr.id}) in ${pr.project}`).join('\n')
      : '  (none)';

    // Format issues
    const issuesText = activity.issues.length > 0
      ? activity.issues.map((issue: any) => `  - ${issue.action}: ${issue.title} (#${issue.id}) in ${issue.project}`).join('\n')
      : '  (none)';

    return {
      content: [
        {
          type: 'text',
          text: `✅ GitHub activity fetched for ${dateStr} ${cacheIndicator}

**Commits (${activity.commits.length}):**
${commitsText}

**Pull Requests (${activity.mergeRequests.length}):**
${prsText}

**Issues (${activity.issues.length}):**
${issuesText}`,
        },
      ],
    };
  }

  private async handleFetchGitHubActivityRange(args: any, githubToken: string) {
    // Validate date formats
    const startDateStr = args.start_date;
    const endDateStr = args.end_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    // Parse dates
    const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
    const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
    const startDate = new Date(startYear, startMonth - 1, startDay);
    const endDate = new Date(endYear, endMonth - 1, endDay);

    // Validate range
    if (startDate > endDate) {
      throw new Error('start_date must be before or equal to end_date');
    }

    await this.github.initialize(githubToken);

    const forceRefresh = args?.force_refresh ?? false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Loop through all dates in range and fetch activity
    const allActivities: { [date: string]: any } = {};
    let totalCommits = 0;
    let totalPRs = 0;
    let totalIssues = 0;
    let cacheHits = 0;
    let freshFetches = 0;

    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;

      // Skip future dates
      if (currentDate > today) {
        allActivities[dateStr] = {
          date: new Date(currentDate),
          commits: [],
          mergeRequests: [],
          issues: [],
          isFuture: true,
        };
      } else {
        const { activity, fromCache } = await this.fetchGitHubActivityWithCache(dateStr, forceRefresh);
        allActivities[dateStr] = activity;
        totalCommits += activity.commits.length;
        totalPRs += activity.mergeRequests.length;
        totalIssues += activity.issues.length;
        if (fromCache) cacheHits++;
        else freshFetches++;
      }

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Format output grouped by date
    const dateEntries = Object.entries(allActivities)
      .map(([dateStr, activity]) => {
        if (activity.isFuture) {
          return `📅 **${dateStr}** (future date)\n  - No activity (future date)`;
        }

        if (activity.commits.length === 0 && activity.mergeRequests.length === 0 && activity.issues.length === 0) {
          return `📅 **${dateStr}**\n  - No activity`;
        }

        let details = `📅 **${dateStr}**\n\n`;

        // Format commits with details
        if (activity.commits.length > 0) {
          details += `**Commits (${activity.commits.length}):**\n`;
          details += activity.commits.map((c: any) => `  - ${c.message} (${c.project})`).join('\n');
          details += '\n\n';
        }

        // Format PRs with details
        if (activity.mergeRequests.length > 0) {
          details += `**Pull Requests (${activity.mergeRequests.length}):**\n`;
          details += activity.mergeRequests.map((pr: any) => `  - ${pr.action}: ${pr.title} (#${pr.id}) in ${pr.project}`).join('\n');
          details += '\n\n';
        }

        // Format issues with details
        if (activity.issues.length > 0) {
          details += `**Issues (${activity.issues.length}):**\n`;
          details += activity.issues.map((issue: any) => `  - ${issue.action}: ${issue.title} (#${issue.id}) in ${issue.project}`).join('\n');
        }

        return details.trim();
      })
      .join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

    const cacheInfo = cacheHits > 0 || freshFetches > 0
      ? `📋 Cache: ${cacheHits} hit${cacheHits !== 1 ? 's' : ''}, ${freshFetches} fresh fetch${freshFetches !== 1 ? 'es' : ''}`
      : '';

    // Add debug info
    const debugText = `

📊 **RAW ACTIVITY DATA:**
\`\`\`json
${JSON.stringify(allActivities, null, 2)}
\`\`\``;

    return {
      content: [
        {
          type: 'text',
          text: `✅ GitHub activity fetched for ${startDateStr} to ${endDateStr}

**Summary:**
- Total Commits: ${totalCommits}
- Total Pull Requests: ${totalPRs}
- Total Issues: ${totalIssues}
${cacheInfo}

**Activity by Date:**
${dateEntries}${debugText}`,
        },
      ],
    };
  }

  private async handleFetchGoogleCalendarEvents(args: any) {
    await this.tokenStorage.load();
    await this.activityCache.load();
    const config = await this.loadConfig();

    const googleTokens = this.tokenStorage.getGoogleTokens();
    if (!googleTokens || !config.google) {
      throw new Error('Google Calendar not configured. Please use configure_google_calendar tool first.');
    }

    // Check if date range is provided
    if (args.start_date && args.end_date) {
      // Handle date range
      return this.handleFetchGoogleCalendarEventsRange(args, config, googleTokens);
    } else if (args.date) {
      // Handle single date
      return this.handleFetchGoogleCalendarEventsSingle(args, config, googleTokens);
    } else {
      throw new Error('Either date OR start_date+end_date must be provided');
    }
  }

  private async handleFetchGoogleCalendarEventsSingle(args: any, config: any, googleTokens: any) {
    // Validate date format
    const dateStr = args.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    await this.googleCalendar.initialize(
      config.google.clientId,
      config.google.clientSecret,
      config.google.redirectUri,
      googleTokens,
      async (refreshedTokens) => {
        await this.tokenStorage.setGoogleTokens(refreshedTokens);
      }
    );

    const forceRefresh = args?.force_refresh ?? false;
    const { meetings, fromCache } = await this.fetchCalendarEventsWithCache(dateStr, true, false, forceRefresh);
    const cacheIndicator = fromCache ? '📋 (from cache)' : '🔄 (fresh)';

    // Format calendar events
    const eventsText = meetings.length > 0
      ? meetings.map((m: any) => `  - ${m.title || m.summary || 'Unnamed meeting'}`).join('\n')
      : '  (none)';

    return {
      content: [
        {
          type: 'text',
          text: `✅ Google Calendar events fetched for ${dateStr} ${cacheIndicator}

**Calendar Events (${meetings.length}):**
${eventsText}`,
        },
      ],
    };
  }

  private async handleFetchGoogleCalendarEventsRange(args: any, config: any, googleTokens: any) {
    // Validate date formats
    const startDateStr = args.start_date;
    const endDateStr = args.end_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    // Parse dates
    const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
    const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
    const startDate = new Date(startYear, startMonth - 1, startDay);
    const endDate = new Date(endYear, endMonth - 1, endDay);

    // Validate range
    if (startDate > endDate) {
      throw new Error('start_date must be before or equal to end_date');
    }

    await this.googleCalendar.initialize(
      config.google.clientId,
      config.google.clientSecret,
      config.google.redirectUri,
      googleTokens,
      async (refreshedTokens) => {
        await this.tokenStorage.setGoogleTokens(refreshedTokens);
      }
    );

    const forceRefresh = args?.force_refresh ?? false;

    // Loop through all dates in range and fetch events
    const allEvents: { [date: string]: any[] } = {};
    let totalEvents = 0;
    let cacheHits = 0;
    let freshFetches = 0;

    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;

      const { meetings, fromCache } = await this.fetchCalendarEventsWithCache(dateStr, true, false, forceRefresh);
      allEvents[dateStr] = meetings;
      totalEvents += meetings.length;
      if (fromCache) cacheHits++;
      else freshFetches++;

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Format output grouped by date
    const dateEntries = Object.entries(allEvents)
      .map(([dateStr, meetings]) => {
        if (meetings.length === 0) {
          return `📅 **${dateStr}**\n  - No events`;
        }

        let details = `📅 **${dateStr}**\n\n**Calendar Events (${meetings.length}):**\n`;
        details += meetings.map((m: any) => `  - ${m.title || m.summary || 'Unnamed meeting'}`).join('\n');
        return details;
      })
      .join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

    const cacheInfo = cacheHits > 0 || freshFetches > 0
      ? `📋 Cache: ${cacheHits} hit${cacheHits !== 1 ? 's' : ''}, ${freshFetches} fresh fetch${freshFetches !== 1 ? 'es' : ''}`
      : '';

    return {
      content: [
        {
          type: 'text',
          text: `✅ Google Calendar events fetched for ${startDateStr} to ${endDateStr}

**Summary:**
- Total Events: ${totalEvents}
${cacheInfo}

**Events by Date:**
${dateEntries}`,
        },
      ],
    };
  }

  private async handleFetchOutlookCalendarEvents(args: any) {
    await this.tokenStorage.load();
    await this.activityCache.load();
    const config = await this.loadConfig();

    const outlookTokens = this.tokenStorage.getOutlookTokens();
    if (!outlookTokens || !config.outlook) {
      throw new Error('Outlook Calendar not configured. Please use configure_outlook_calendar tool first.');
    }

    // Check if date range is provided
    if (args.start_date && args.end_date) {
      // Handle date range
      return this.handleFetchOutlookCalendarEventsRange(args, config, outlookTokens);
    } else if (args.date) {
      // Handle single date
      return this.handleFetchOutlookCalendarEventsSingle(args, config, outlookTokens);
    } else {
      throw new Error('Either date OR start_date+end_date must be provided');
    }
  }

  private async handleFetchOutlookCalendarEventsSingle(args: any, config: any, outlookTokens: any) {
    // Validate date format
    const dateStr = args.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    await this.outlookCalendar.initialize(
      config.outlook.clientId,
      config.outlook.clientSecret,
      config.outlook.tenantId,
      outlookTokens
    );

    const forceRefresh = args?.force_refresh ?? false;
    const { meetings, fromCache } = await this.fetchCalendarEventsWithCache(dateStr, false, true, forceRefresh);
    const cacheIndicator = fromCache ? '📋 (from cache)' : '🔄 (fresh)';

    return {
      content: [
        {
          type: 'text',
          text: `✅ Outlook Calendar events fetched for ${dateStr} ${cacheIndicator}\n\n**Events:** ${meetings.length}\n\nℹ️ **Next steps:** You can now combine this with Git activity to build a complete timesheet entry.`,
        },
      ],
    };
  }

  private async handleFetchOutlookCalendarEventsRange(args: any, config: any, outlookTokens: any) {
    // Validate date formats
    const startDateStr = args.start_date;
    const endDateStr = args.end_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    // Parse dates
    const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
    const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
    const startDate = new Date(startYear, startMonth - 1, startDay);
    const endDate = new Date(endYear, endMonth - 1, endDay);

    // Validate range
    if (startDate > endDate) {
      throw new Error('start_date must be before or equal to end_date');
    }

    await this.outlookCalendar.initialize(
      config.outlook.clientId,
      config.outlook.clientSecret,
      config.outlook.tenantId,
      outlookTokens
    );

    const forceRefresh = args?.force_refresh ?? false;

    // Loop through all dates in range and fetch events
    const allEvents: { [date: string]: any[] } = {};
    let totalEvents = 0;
    let cacheHits = 0;
    let freshFetches = 0;

    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;

      const { meetings, fromCache } = await this.fetchCalendarEventsWithCache(dateStr, false, true, forceRefresh);
      allEvents[dateStr] = meetings;
      totalEvents += meetings.length;
      if (fromCache) cacheHits++;
      else freshFetches++;

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Format output grouped by date
    const dateEntries = Object.entries(allEvents)
      .map(([dateStr, meetings]) => {
        if (meetings.length === 0) {
          return `📅 **${dateStr}**\n  - No events`;
        }

        let details = `📅 **${dateStr}**\n\n**Calendar Events (${meetings.length}):**\n`;
        details += meetings.map((m: any) => `  - ${m.title || m.summary || 'Unnamed meeting'}`).join('\n');
        return details;
      })
      .join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

    const cacheInfo = cacheHits > 0 || freshFetches > 0
      ? `📋 Cache: ${cacheHits} hit${cacheHits !== 1 ? 's' : ''}, ${freshFetches} fresh fetch${freshFetches !== 1 ? 'es' : ''}`
      : '';

    return {
      content: [
        {
          type: 'text',
          text: `✅ Outlook Calendar events fetched for ${startDateStr} to ${endDateStr}

**Summary:**
- Total Events: ${totalEvents}
${cacheInfo}

**Events by Date:**
${dateEntries}`,
        },
      ],
    };
  }

  // Helper method to merge GitLab and GitHub activities
  private mergeGitActivities(gitlabActivity: any, githubActivity: any): any {
    return {
      date: gitlabActivity.date,
      commits: [...gitlabActivity.commits, ...githubActivity.commits],
      mergeRequests: [...gitlabActivity.mergeRequests, ...githubActivity.mergeRequests],
      issues: [...gitlabActivity.issues, ...githubActivity.issues],
    };
  }

  // Helper method to fetch GitLab activity with caching
  private async fetchGitLabActivityWithCache(dateStr: string, forceRefresh: boolean): Promise<{ activity: any; fromCache: boolean }> {
    // Parse date for cache lookup
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    if (!forceRefresh) {
      const cached = this.activityCache.getGitLabActivity(date);
      if (cached) {
        await this.sendProgress(`✓ GitLab (${dateStr}) - from cache`);
        return { activity: cached, fromCache: true };
      }
    }

    await this.sendProgress(`⏳ Fetching GitLab activity for ${dateStr}...`);
    const activity = await this.gitlab.getActivityForDate(dateStr);
    await this.activityCache.setGitLabActivity(date, activity);
    await this.sendProgress(`✓ GitLab (${dateStr}) - ${activity.commits.length} commits, ${activity.mergeRequests.length} MRs`);
    return { activity, fromCache: false };
  }

  // Helper method to fetch GitHub activity with caching
  private async fetchGitHubActivityWithCache(dateStr: string, forceRefresh: boolean): Promise<{ activity: any; fromCache: boolean }> {
    // Parse date for cache lookup
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    if (!forceRefresh) {
      const cached = this.activityCache.getGitLabActivity(date); // Reuse same cache structure
      if (cached) {
        await this.sendProgress(`✓ GitHub (${dateStr}) - from cache`);
        return { activity: cached, fromCache: true };
      }
    }

    await this.sendProgress(`⏳ Fetching GitHub activity for ${dateStr}...`);
    const activity = await this.github.getActivityForDate(dateStr);
    await this.activityCache.setGitLabActivity(date, activity); // Reuse same cache structure
    await this.sendProgress(`✓ GitHub (${dateStr}) - ${activity.commits.length} commits, ${activity.mergeRequests.length} PRs`);
    return { activity, fromCache: false };
  }

  // Helper method to fetch calendar events with caching
  private async fetchCalendarEventsWithCache(
    dateStr: string,
    googleAuthenticated: boolean,
    outlookAuthenticated: boolean,
    forceRefresh: boolean
  ): Promise<{ meetings: any[]; fromCache: boolean }> {
    // Parse date for cache lookup
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    let meetings: any[] = [];
    let fromCache = false;

    // Prioritize Google Calendar
    if (googleAuthenticated) {
      if (!forceRefresh) {
        const cached = this.activityCache.getGoogleCalendarEvents(date);
        if (cached) {
          await this.sendProgress(`✓ Google Calendar (${dateStr}) - from cache`);
          return { meetings: cached, fromCache: true };
        }
      }

      try {
        await this.sendProgress(`⏳ Fetching Google Calendar events for ${dateStr}...`);
        meetings = await this.googleCalendar.getEventsForDate(dateStr);
        await this.activityCache.setGoogleCalendarEvents(date, meetings);
        await this.sendProgress(`✓ Google Calendar (${dateStr}) - ${meetings.length} events`);
      } catch (error) {
        await this.sendProgress(`⚠️ Google Calendar (${dateStr}) - fetch failed`, 'warning');
        console.error('Error fetching Google Calendar events:', error);
      }
    }

    // If no Google meetings, try Outlook
    if (meetings.length === 0 && outlookAuthenticated) {
      if (!forceRefresh) {
        const cached = this.activityCache.getOutlookCalendarEvents(date);
        if (cached) {
          await this.sendProgress(`✓ Outlook Calendar (${dateStr}) - from cache`);
          return { meetings: cached, fromCache: true };
        }
      }

      try {
        await this.sendProgress(`⏳ Fetching Outlook Calendar events for ${dateStr}...`);
        meetings = await this.outlookCalendar.getEventsForDate(dateStr);
        await this.activityCache.setOutlookCalendarEvents(date, meetings);
        await this.sendProgress(`✓ Outlook Calendar (${dateStr}) - ${meetings.length} events`);
      } catch (error) {
        await this.sendProgress(`⚠️ Outlook Calendar (${dateStr}) - fetch failed`, 'warning');
        console.error('Error fetching Outlook Calendar events:', error);
      }
    }

    return { meetings, fromCache };
  }

  // Batch parallel fetch for multiple days with error isolation
  private async fetchMultipleDaysParallel(
    dates: Date[],
    gitlabAuthenticated: boolean,
    githubAuthenticated: boolean,
    googleAuthenticated: boolean,
    outlookAuthenticated: boolean,
    forceRefresh: boolean
  ): Promise<Array<{ activity: DayActivity; cacheInfo: { gitlab: boolean; github: boolean; calendar: boolean } }>> {
    // Send detailed source notifications
    const dateRange = dates.length > 1
      ? `${dates[0].toISOString().split('T')[0]} to ${dates[dates.length - 1].toISOString().split('T')[0]}`
      : dates[0].toISOString().split('T')[0];

    const sources: string[] = [];
    if (gitlabAuthenticated) sources.push('GitLab');
    if (githubAuthenticated) sources.push('GitHub');
    if (googleAuthenticated) sources.push('Google Calendar');
    if (outlookAuthenticated) sources.push('Outlook Calendar');

    if (sources.length > 0) {
      await this.sendProgress(`🔄 Fetching from ${sources.join(', ')} for ${dateRange}...`);
    }

    // Fetch all days in parallel
    const promises = dates.map(date => {
      // Convert date to YYYY-MM-DD string
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      return this.fetchDayActivityParallel(
        dateStr,
        gitlabAuthenticated,
        githubAuthenticated,
        googleAuthenticated,
        outlookAuthenticated,
        forceRefresh
      );
    });

    return await Promise.all(promises);
  }

  // Parallel fetch for a single day with error isolation
  private async fetchDayActivityParallel(
    dateStr: string,
    gitlabAuthenticated: boolean,
    githubAuthenticated: boolean,
    googleAuthenticated: boolean,
    outlookAuthenticated: boolean,
    forceRefresh: boolean
  ): Promise<{ activity: DayActivity; cacheInfo: { gitlab: boolean; github: boolean; calendar: boolean } }> {
    // Parse date for fallback data
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    // Fetch all sources in parallel with error isolation
    const [gitlabResult, githubResult, calendarResult] = await Promise.allSettled([
      gitlabAuthenticated ? this.fetchGitLabActivityWithCache(dateStr, forceRefresh) : Promise.resolve(null),
      githubAuthenticated ? this.fetchGitHubActivityWithCache(dateStr, forceRefresh) : Promise.resolve(null),
      this.fetchCalendarEventsWithCache(dateStr, googleAuthenticated, outlookAuthenticated, forceRefresh),
    ]);

    // Extract GitLab activity with error handling
    let gitlabActivity = { date, commits: [], mergeRequests: [], issues: [] };
    let gitlabCached = false;
    if (gitlabResult.status === 'fulfilled' && gitlabResult.value) {
      gitlabActivity = gitlabResult.value.activity;
      gitlabCached = gitlabResult.value.fromCache;
    } else if (gitlabResult.status === 'rejected') {
      console.error(`GitLab fetch failed for ${dateStr}:`, gitlabResult.reason);
    }

    // Extract GitHub activity with error handling
    let githubActivity = { date, commits: [], mergeRequests: [], issues: [] };
    let githubCached = false;
    if (githubResult.status === 'fulfilled' && githubResult.value) {
      githubActivity = githubResult.value.activity;
      githubCached = githubResult.value.fromCache;
    } else if (githubResult.status === 'rejected') {
      console.error(`GitHub fetch failed for ${date.toISOString()}:`, githubResult.reason);
    }

    // Extract calendar events with error handling
    let meetings: any[] = [];
    let calendarCached = false;
    if (calendarResult.status === 'fulfilled') {
      meetings = calendarResult.value.meetings;
      calendarCached = calendarResult.value.fromCache;
    } else if (calendarResult.status === 'rejected') {
      console.error(`Calendar fetch failed for ${date.toISOString()}:`, calendarResult.reason);
    }

    // Merge GitLab and GitHub activities
    const mergedActivity = this.mergeGitActivities(gitlabActivity, githubActivity);

    return {
      activity: {
        date,
        meetings,
        gitlabActivity: mergedActivity,
        description: '',
      },
      cacheInfo: {
        gitlab: gitlabCached,
        github: githubCached,
        calendar: calendarCached,
      },
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Activity Collector MCP server running on stdio');
  }
}

const server = new ActivityCollectorMCPServer();
server.run().catch(console.error);
