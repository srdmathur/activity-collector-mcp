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
import { OutlookLocalIntegration } from './integrations/outlookLocal.js';
import { AzureDevOpsIntegration, azSetupInstructions } from './integrations/azureDevOps.js';
import { TokenStorage } from './utils/tokenStorage.js';
import { ActivityCache } from './utils/cache.js';
import { Config, DayActivity } from './types/index.js';
import { runOAuthFlow } from './utils/oauthFlow.js';
import { GitLabOAuth } from './utils/gitlabOAuth.js';
import { BUNDLED_OAUTH_CREDENTIALS, OAUTH_SCOPES } from './config/oauth.js';
import { OAuth2Client } from 'google-auth-library';
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
  private outlookLocal: OutlookLocalIntegration;
  private azureDevOps: AzureDevOpsIntegration;
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
    this.outlookLocal = new OutlookLocalIntegration();
    this.azureDevOps = new AzureDevOpsIntegration();
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
          name: 'start_google_auth',
          description: 'Step 1: Start Google Calendar OAuth authentication. Opens browser and returns authorization code. Fast and reliable.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'complete_google_auth',
          description: 'Step 2: Complete Google Calendar authentication by exchanging authorization code for tokens. Call this immediately after start_google_auth.',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Authorization code from start_google_auth',
              },
              redirect_uri: {
                type: 'string',
                description: 'Redirect URI from start_google_auth (e.g., "http://localhost:8080/callback")',
              },
            },
            required: ['code', 'redirect_uri'],
          },
        },
        {
          name: 'start_gitlab_auth',
          description: 'Step 1: Start GitLab OAuth authentication. Opens browser and returns authorization code. Fast and reliable.',
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
          name: 'complete_gitlab_auth',
          description: 'Step 2: Complete GitLab authentication by exchanging authorization code for tokens. Call this immediately after start_gitlab_auth.',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Authorization code from start_gitlab_auth',
              },
              redirect_uri: {
                type: 'string',
                description: 'Redirect URI from start_gitlab_auth (e.g., "http://localhost:8080/callback")',
              },
              gitlab_url: {
                type: 'string',
                description: 'GitLab instance URL (optional, defaults to https://gitlab.com)',
              },
            },
            required: ['code', 'redirect_uri'],
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
          name: 'configure_azure_devops',
          description:
            'Configure Azure DevOps. No personal access token is required - authentication uses the Azure CLI (az login), and no secret is stored. Validates the connection and reports which projects are visible. Re-run with a projects list to narrow which projects are scanned.',
          inputSchema: {
            type: 'object',
            properties: {
              organization: {
                type: 'string',
                description:
                  'Azure DevOps organization name - the segment after dev.azure.com/ in your browser URL (e.g. "mycompany").',
              },
              projects: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Optional. Limit activity fetching to these project names. Omit to scan every visible project, which is slower.',
              },
              tenant: {
                type: 'string',
                description:
                  'Optional. Entra tenant ID, needed only when the Azure DevOps organization lives in a different tenant than your default az login.',
              },
            },
            required: ['organization'],
          },
        },
        {
          name: 'fetch_azure_devops_activity',
          description:
            'Fetch Azure DevOps activity (work items, pull requests, commits) for a single date OR a date range. Requires configure_azure_devops first.',
          inputSchema: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: 'Single date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
              },
              start_date: {
                type: 'string',
                description: 'Start date for range in YYYY-MM-DD format. Must be used with end_date.',
              },
              end_date: {
                type: 'string',
                description: 'End date for range in YYYY-MM-DD format. Must be used with start_date.',
              },
              force_refresh: {
                type: 'boolean',
                description: 'Optional. Bypass cache and fetch fresh data. Default: false.',
              },
            },
          },
        },
        {
          name: 'fetch_outlook_calendar_events',
          description:
            'Fetch Outlook Calendar events for a single date OR a date range by reading the locally installed Outlook desktop client. Requires no authentication or setup. Windows requires classic Outlook (the "new Outlook" app does not support automation); macOS requires Outlook for Mac.',
          inputSchema: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: 'Single date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
              },
              start_date: {
                type: 'string',
                description: 'Start date for range in YYYY-MM-DD format. Must be used with end_date.',
              },
              end_date: {
                type: 'string',
                description: 'End date for range in YYYY-MM-DD format. Must be used with start_date.',
              },
              force_refresh: {
                type: 'boolean',
                description: 'Optional. Bypass cache and fetch fresh data. Default: false.',
              },
            },
          },
        },
        {
          name: 'clear_cache',
          description: 'Clear cached timesheet data. Useful when you want to force fresh data fetch for all future requests.',
          inputSchema: {
            type: 'object',
            properties: {
              scope: {
                type: 'string',
                description:
                  'Optional. What to clear: "all" (everything), "gitlab", "calendars", "azure_devops", or "expired" (only expired entries). Default: "all".',
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

          case 'start_google_auth':
            return await this.handleStartGoogleAuth();

          case 'complete_google_auth':
            return await this.handleCompleteGoogleAuth(request.params.arguments);

          case 'start_gitlab_auth':
            return await this.handleStartGitLabAuth(request.params.arguments);

          case 'complete_gitlab_auth':
            return await this.handleCompleteGitLabAuth(request.params.arguments);

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

          case 'configure_azure_devops':
            return await this.handleConfigureAzureDevOps(request.params.arguments);

          case 'fetch_azure_devops_activity':
            return await this.handleFetchAzureDevOpsActivity(request.params.arguments);

          case 'fetch_outlook_calendar_events':
            return await this.handleFetchOutlookLocalEvents(request.params.arguments);

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

    const lines: string[] = ['Authentication Status:'];

    lines.push(
      `- GitLab: ${this.tokenStorage.hasGitLabToken() ? '✓ Configured' : '✗ Not configured — use start_gitlab_auth'}`
    );
    lines.push(
      `- Google Calendar: ${this.tokenStorage.hasGoogleTokens() ? '✓ Configured' : '✗ Not configured — use start_google_auth'}`
    );

    // Outlook needs no credential at all, so the only question is whether this
    // platform has a local bridge available.
    if (OutlookLocalIntegration.isSupported()) {
      lines.push('- Outlook Calendar: ✓ Available (reads local Outlook desktop, no setup required)');
      if (process.platform === 'win32') {
        lines.push(
          '    Requires classic Outlook. The "new Outlook" app cannot be automated — if fetches fail,'
        );
        lines.push('    turn off the "New Outlook" toggle in Outlook and reopen it.');
      }
    } else {
      lines.push(`- Outlook Calendar: ✗ Unsupported platform (${process.platform})`);
      lines.push('    ' + OutlookLocalIntegration.unsupportedMessage().split('\n').join('\n    '));
    }

    const ado = this.tokenStorage.getAzureDevOps();
    if (ado?.organization) {
      const scope = ado.projects?.length
        ? `projects: ${ado.projects.join(', ')}`
        : 'all visible projects (slower — narrow with configure_azure_devops)';
      lines.push(`- Azure DevOps: ✓ Configured (org: ${ado.organization}, ${scope})`);
      if (ado.tenant) lines.push(`    tenant: ${ado.tenant}`);
    } else {
      lines.push('- Azure DevOps: ✗ Not configured');
      lines.push('    ' + azSetupInstructions().split('\n').join('\n    '));
      lines.push('    Then run configure_azure_devops with your organization name.');
    }

    // Jira is deliberately not implemented here: it is served by the Atlassian
    // MCP, which this server cannot call. An MCP server has no visibility into
    // which other servers the client has loaded, so this notice is
    // unconditional rather than a detected state.
    lines.push('- Jira: ⓘ Provided by the Atlassian MCP, not by this server.');
    lines.push('    If Jira tools are unavailable, install the Atlassian MCP:');
    lines.push('      claude mcp add --transport sse atlassian https://mcp.atlassian.com/v1/sse');
    lines.push('    then authorise in the browser when prompted.');

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
        },
      ],
    };
  }

  private async handleStartGoogleAuth() {
    try {
      // Load config to check for custom OAuth credentials
      let clientId = BUNDLED_OAUTH_CREDENTIALS.google.clientId;
      let clientSecret = BUNDLED_OAUTH_CREDENTIALS.google.clientSecret;

      try {
        const config = await this.loadConfig();
        if (config.google?.clientId && config.google?.clientSecret) {
          clientId = config.google.clientId;
          clientSecret = config.google.clientSecret;
        }
      } catch (error) {
        // Config file not found, use bundled credentials
      }

      // Run OAuth flow - only capture authorization code
      const result = await runOAuthFlow((redirectUri) => {
        // Create OAuth2 client to generate auth URL
        const tempOAuth2Client = new OAuth2Client(
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

      const redirectUri = `http://localhost:${result.port}/callback`;

      return {
        content: [
          {
            type: 'text',
            text: `✅ Step 1 Complete: Authorization code received!

Authorization Code: ${result.code}
Redirect URI: ${redirectUri}

Next step: Call complete_google_auth with these values to finish authentication.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Google Calendar authorization failed: ${error.message}

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

  private async handleCompleteGoogleAuth(args: any) {
    try {
      const code = args?.code;
      const redirectUri = args?.redirect_uri;

      if (!code) {
        throw new Error('Missing required parameter: code');
      }
      if (!redirectUri) {
        throw new Error('Missing required parameter: redirect_uri');
      }

      // Load config to check for custom OAuth credentials
      let clientId = BUNDLED_OAUTH_CREDENTIALS.google.clientId;
      let clientSecret = BUNDLED_OAUTH_CREDENTIALS.google.clientSecret;

      try {
        const config = await this.loadConfig();
        if (config.google?.clientId && config.google?.clientSecret) {
          clientId = config.google.clientId;
          clientSecret = config.google.clientSecret;
        }
      } catch (error) {
        // Config file not found, use bundled credentials
      }

      // Exchange code for tokens
      await this.googleCalendar.initialize(clientId, clientSecret, redirectUri);
      const tokens = await this.googleCalendar.setAuthorizationCode(code);

      // Save tokens
      await this.tokenStorage.load();
      await this.tokenStorage.setGoogleTokens(tokens);

      return {
        content: [
          {
            type: 'text',
            text: `✅ Step 2 Complete: Successfully authenticated with Google Calendar!

Your access token has been saved and will be automatically refreshed when needed.
You can now use fetch_google_calendar_events to retrieve calendar data.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to complete Google Calendar authentication: ${error.message}

Please make sure you provided the correct authorization code and redirect URI from start_google_auth.`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleStartGitLabAuth(args: any) {
    try {
      const gitlabUrl = args?.gitlab_url || 'https://gitlab.com';

      // Get OAuth credentials
      const applicationId = BUNDLED_OAUTH_CREDENTIALS.gitlab.applicationId;
      const secret = BUNDLED_OAUTH_CREDENTIALS.gitlab.secret;

      // Create GitLab OAuth helper
      const gitlabOAuth = new GitLabOAuth({
        applicationId,
        secret,
        gitlabUrl,
      });

      // Run OAuth flow - only capture authorization code
      const result = await runOAuthFlow((redirectUri) => {
        return gitlabOAuth.getAuthUrl(redirectUri, OAUTH_SCOPES.gitlab.api);
      });

      if (result.error) {
        throw new Error(`OAuth failed: ${result.error}`);
      }

      if (!result.code) {
        throw new Error('No authorization code received');
      }

      const redirectUri = `http://localhost:${result.port}/callback`;

      return {
        content: [
          {
            type: 'text',
            text: `✅ Step 1 Complete: Authorization code received!

Authorization Code: ${result.code}
Redirect URI: ${redirectUri}
GitLab URL: ${gitlabUrl}

Next step: Call complete_gitlab_auth with these values to finish authentication.`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ GitLab authorization failed: ${error.message}

Troubleshooting:
1. Make sure you clicked "Authorize" in the browser
2. Check that ports 8080-8090 are not blocked by firewall
3. Verify the GitLab URL is correct: ${args?.gitlab_url || 'https://gitlab.com'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleCompleteGitLabAuth(args: any) {
    try {
      const code = args?.code;
      const redirectUri = args?.redirect_uri;
      const gitlabUrl = args?.gitlab_url || 'https://gitlab.com';

      if (!code) {
        throw new Error('Missing required parameter: code');
      }
      if (!redirectUri) {
        throw new Error('Missing required parameter: redirect_uri');
      }

      // Get OAuth credentials
      const applicationId = BUNDLED_OAUTH_CREDENTIALS.gitlab.applicationId;
      const secret = BUNDLED_OAUTH_CREDENTIALS.gitlab.secret;

      // Create GitLab OAuth helper
      const gitlabOAuth = new GitLabOAuth({
        applicationId,
        secret,
        gitlabUrl,
      });

      // Exchange code for tokens
      const tokens = await gitlabOAuth.getTokenFromCode(code, redirectUri);

      // Save tokens
      await this.tokenStorage.load();
      await this.tokenStorage.setGitLabOAuthTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        created_at: tokens.created_at,
        expires_in: tokens.expires_in,
      });

      return {
        content: [
          {
            type: 'text',
            text: `✅ Step 2 Complete: Successfully authenticated with GitLab (${gitlabUrl})!

Your access token has been saved and will be automatically refreshed when needed.
You can now use fetch_gitlab_activity to retrieve your GitLab activity.

Token info:
- Access token saved: ${tokens.access_token.substring(0, 8)}...
- Expires in: ${tokens.expires_in ? `${tokens.expires_in / 3600} hours` : 'N/A'}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to complete GitLab authentication: ${error.message}

Please make sure you provided the correct authorization code, redirect URI, and GitLab URL from start_gitlab_auth.

If the error mentions "redirect_uri_mismatch", the OAuth app may need to be reconfigured.`,
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
      case 'azure_devops':
      case 'azuredevops':
      case 'ado':
        await this.activityCache.clearAzureDevOps();
        message = 'Azure DevOps cache cleared successfully.';
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
    message += `\n\nCache Status:\n- GitLab entries: ${info.gitlabEntries}\n- Google Calendar entries: ${info.googleCalendarEntries}\n- Outlook Calendar entries: ${info.outlookCalendarEntries}\n- Azure DevOps entries: ${info.azureDevopsEntries}`;

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

    const googleTokens = this.tokenStorage.getGoogleTokens();
    if (!googleTokens) {
      throw new Error('Google Calendar not configured. Please use authenticate_google tool first.');
    }

    // Check if date range is provided
    if (args.start_date && args.end_date) {
      // Handle date range
      return this.handleFetchGoogleCalendarEventsRange(args, googleTokens);
    } else if (args.date) {
      // Handle single date
      return this.handleFetchGoogleCalendarEventsSingle(args, googleTokens);
    } else {
      throw new Error('Either date OR start_date+end_date must be provided');
    }
  }

  private async handleFetchGoogleCalendarEventsSingle(args: any, googleTokens: any) {
    // Validate date format
    const dateStr = args.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
    }

    await this.googleCalendar.initialize(
      BUNDLED_OAUTH_CREDENTIALS.google.clientId,
      BUNDLED_OAUTH_CREDENTIALS.google.clientSecret,
      'http://localhost:8080/callback', // redirectUri not used for token refresh
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

  private async handleFetchGoogleCalendarEventsRange(args: any, googleTokens: any) {
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
      BUNDLED_OAUTH_CREDENTIALS.google.clientId,
      BUNDLED_OAUTH_CREDENTIALS.google.clientSecret,
      'http://localhost:8080/callback', // redirectUri not used for token refresh
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

  // -------------------------------------------------------------------------
  // Azure DevOps
  // -------------------------------------------------------------------------

  private async handleConfigureAzureDevOps(args: any) {
    const organization = args?.organization;
    if (!organization || typeof organization !== 'string') {
      throw new Error('organization is required (the segment after dev.azure.com/ in your browser URL)');
    }

    const projects = Array.isArray(args?.projects)
      ? args.projects.filter((p: unknown) => typeof p === 'string' && p.trim() !== '')
      : undefined;
    const tenant = typeof args?.tenant === 'string' && args.tenant.trim() !== '' ? args.tenant : undefined;

    await this.azureDevOps.initialize({ organization, projects, tenant });

    // Validate before saving so a bad organization name is never persisted.
    const { identity, projects: visible } = await this.azureDevOps.validate();

    await this.tokenStorage.load();
    await this.tokenStorage.setAzureDevOps({ organization, projects, tenant });

    const lines = [
      `✅ Azure DevOps configured for organization "${organization}"`,
      '',
      `Authenticated as: ${identity.displayName}${identity.email ? ` <${identity.email}>` : ''}`,
      `Projects visible: ${visible.length}`,
    ];

    if (visible.length > 0) {
      lines.push(`  ${visible.slice(0, 25).join(', ')}${visible.length > 25 ? ', …' : ''}`);
    }

    if (projects?.length) {
      lines.push('', `Scanning limited to: ${projects.join(', ')}`);
      const unknown = projects.filter((p: string) => !visible.includes(p));
      if (unknown.length > 0) {
        lines.push(`⚠ Not found among visible projects: ${unknown.join(', ')}`);
      }
    } else if (visible.length > 3) {
      lines.push(
        '',
        `⚠ No project scope set, so commit fetching will sweep all ${visible.length} projects and will be slow.`,
        '  Narrow it by re-running configure_azure_devops with a projects list.'
      );
    }

    if (!identity.email) {
      lines.push(
        '',
        '⚠ No account email resolved, so commit lookups will be skipped (commit search matches on author alias).'
      );
    }

    lines.push('', 'No token was stored — access is minted on demand via the Azure CLI.');

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  private async ensureAzureDevOpsReady(): Promise<void> {
    await this.tokenStorage.load();
    const settings = this.tokenStorage.getAzureDevOps();
    if (!settings?.organization) {
      throw new Error(
        `Azure DevOps not configured.\n\n${azSetupInstructions()}\n\nThen run configure_azure_devops with your organization name.`
      );
    }
    await this.azureDevOps.initialize(settings);
  }

  private formatAzureDevOpsActivity(activity: any): string {
    const parts: string[] = [];

    parts.push(`**Work Items (${activity.workItems.length}):**`);
    parts.push(
      activity.workItems.length > 0
        ? activity.workItems
            .map((w: any) => {
              const transition =
                w.stateTo && w.stateFrom
                  ? ` (${w.stateFrom} → ${w.stateTo})`
                  : w.stateTo
                    ? ` (→ ${w.stateTo})`
                    : '';
              return `  - [${w.actions.join(', ')}] ${w.type} #${w.id}: ${w.title}${transition} in ${w.project}`;
            })
            .join('\n')
        : '  (none)'
    );

    parts.push('');
    parts.push(`**Pull Requests (${activity.pullRequests.length}):**`);
    parts.push(
      activity.pullRequests.length > 0
        ? activity.pullRequests
            .map((pr: any) => `  - ${pr.action}: ${pr.title} (#${pr.id}) in ${pr.repository}/${pr.project}`)
            .join('\n')
        : '  (none)'
    );

    parts.push('');
    parts.push(`**Commits (${activity.commits.length}):**`);
    parts.push(
      activity.commits.length > 0
        ? activity.commits.map((c: any) => `  - ${c.message} (${c.repository})`).join('\n')
        : '  (none)'
    );

    // Never let a partial sweep look like full coverage.
    const scanned = activity.scanned;
    parts.push('');
    parts.push(
      `ℹ Scanned ${scanned.projects.length} project(s), ${scanned.repositories} repositor${scanned.repositories === 1 ? 'y' : 'ies'}.` +
        (scanned.commitsSkipped ? ' Commits skipped (no account email resolved).' : '')
    );

    return parts.join('\n');
  }

  private async fetchAzureDevOpsWithCache(
    dateStr: string,
    forceRefresh: boolean
  ): Promise<{ activity: any; fromCache: boolean }> {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    if (!forceRefresh) {
      const cached = this.activityCache.getAzureDevOpsActivity(date);
      if (cached) {
        await this.sendProgress(`✓ Azure DevOps (${dateStr}) - from cache`);
        return { activity: cached, fromCache: true };
      }
    }

    await this.sendProgress(`⏳ Fetching Azure DevOps activity for ${dateStr}...`);
    const activity = await this.azureDevOps.getActivityForDate(dateStr);
    await this.activityCache.setAzureDevOpsActivity(date, activity);
    await this.sendProgress(
      `✓ Azure DevOps (${dateStr}) - ${activity.workItems.length} work items, ${activity.pullRequests.length} PRs, ${activity.commits.length} commits`
    );
    return { activity, fromCache: false };
  }

  private async handleFetchAzureDevOpsActivity(args: any) {
    await this.activityCache.load();
    await this.ensureAzureDevOpsReady();

    const forceRefresh = args?.force_refresh ?? false;
    const dates = this.resolveDateArgs(args);

    if (dates.length === 1) {
      const dateStr = dates[0];
      const { activity, fromCache } = await this.fetchAzureDevOpsWithCache(dateStr, forceRefresh);
      return {
        content: [
          {
            type: 'text',
            text: `✅ Azure DevOps activity for ${dateStr} ${fromCache ? '📋 (from cache)' : '🔄 (fresh)'}\n\n${this.formatAzureDevOpsActivity(activity)}`,
          },
        ],
      };
    }

    const sections: string[] = [];
    let totalWorkItems = 0;
    let totalPRs = 0;
    let totalCommits = 0;

    for (const dateStr of dates) {
      const { activity } = await this.fetchAzureDevOpsWithCache(dateStr, forceRefresh);
      totalWorkItems += activity.workItems.length;
      totalPRs += activity.pullRequests.length;
      totalCommits += activity.commits.length;

      if (
        activity.workItems.length === 0 &&
        activity.pullRequests.length === 0 &&
        activity.commits.length === 0
      ) {
        sections.push(`📅 **${dateStr}**\n  - No activity`);
      } else {
        sections.push(`📅 **${dateStr}**\n\n${this.formatAzureDevOpsActivity(activity)}`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `✅ Azure DevOps activity for ${dates[0]} to ${dates[dates.length - 1]}\n\n` +
            `**Summary:**\n- Total Work Items: ${totalWorkItems}\n- Total Pull Requests: ${totalPRs}\n- Total Commits: ${totalCommits}\n\n` +
            `**Activity by Date:**\n${sections.join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n')}`,
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Outlook (local desktop client)
  // -------------------------------------------------------------------------

  private formatCalendarEvents(events: any[]): string {
    if (events.length === 0) return '  (none)';
    return events
      .map((e: any) => {
        const start = new Date(e.start);
        const end = new Date(e.end);
        const hhmm = (d: Date) =>
          `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const attendees = e.attendees ? ` (${e.attendees} attendees)` : '';
        return `  - ${hhmm(start)}-${hhmm(end)}  ${e.title}${attendees}`;
      })
      .join('\n');
  }

  private async fetchOutlookLocalWithCache(
    dateStr: string,
    forceRefresh: boolean
  ): Promise<{ events: any[]; fromCache: boolean }> {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    if (!forceRefresh) {
      const cached = this.activityCache.getOutlookCalendarEvents(date);
      if (cached) {
        await this.sendProgress(`✓ Outlook Calendar (${dateStr}) - from cache`);
        return { events: cached, fromCache: true };
      }
    }

    await this.sendProgress(`⏳ Reading local Outlook calendar for ${dateStr}...`);
    const events = await this.outlookLocal.getEventsForDate(dateStr);
    await this.activityCache.setOutlookCalendarEvents(date, events);
    await this.sendProgress(`✓ Outlook Calendar (${dateStr}) - ${events.length} events`);
    return { events, fromCache: false };
  }

  private async handleFetchOutlookLocalEvents(args: any) {
    await this.activityCache.load();

    if (!OutlookLocalIntegration.isSupported()) {
      throw new Error(OutlookLocalIntegration.unsupportedMessage());
    }

    const forceRefresh = args?.force_refresh ?? false;
    const dates = this.resolveDateArgs(args);

    if (dates.length === 1) {
      const dateStr = dates[0];
      const { events, fromCache } = await this.fetchOutlookLocalWithCache(dateStr, forceRefresh);
      return {
        content: [
          {
            type: 'text',
            text: `✅ Outlook Calendar events for ${dateStr} ${fromCache ? '📋 (from cache)' : '🔄 (fresh)'}\n\n**Calendar Events (${events.length}):**\n${this.formatCalendarEvents(events)}`,
          },
        ],
      };
    }

    const sections: string[] = [];
    let total = 0;

    for (const dateStr of dates) {
      const { events } = await this.fetchOutlookLocalWithCache(dateStr, forceRefresh);
      total += events.length;
      sections.push(
        events.length === 0
          ? `📅 **${dateStr}**\n  - No events`
          : `📅 **${dateStr}**\n\n**Calendar Events (${events.length}):**\n${this.formatCalendarEvents(events)}`
      );
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `✅ Outlook Calendar events for ${dates[0]} to ${dates[dates.length - 1]}\n\n` +
            `**Summary:**\n- Total Events: ${total}\n\n` +
            `**Events by Date:**\n${sections.join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n')}`,
        },
      ],
    };
  }

  /**
   * Normalises the `date` / `start_date`+`end_date` argument pair into an
   * inclusive list of YYYY-MM-DD strings, matching the existing fetch tools.
   */
  private resolveDateArgs(args: any): string[] {
    const isValid = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

    if (args?.start_date && args?.end_date) {
      if (!isValid(args.start_date) || !isValid(args.end_date)) {
        throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
      }

      const [sy, sm, sd] = args.start_date.split('-').map(Number);
      const [ey, em, ed] = args.end_date.split('-').map(Number);
      const start = new Date(sy, sm - 1, sd);
      const end = new Date(ey, em - 1, ed);

      if (start > end) {
        throw new Error('start_date must be before or equal to end_date');
      }

      const out: string[] = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        out.push(
          `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
        );
        cursor.setDate(cursor.getDate() + 1);
      }
      return out;
    }

    if (args?.date) {
      if (!isValid(args.date)) {
        throw new Error('Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-27")');
      }
      return [args.date];
    }

    throw new Error('Either date OR start_date+end_date must be provided');
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Activity Collector MCP server running on stdio');
  }
}

const server = new ActivityCollectorMCPServer();
server.run().catch(console.error);
