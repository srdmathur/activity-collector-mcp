# Activity Collector MCP

An MCP (Model Context Protocol) server for collecting developer activity data from GitLab, GitHub, Google Calendar, and Outlook Calendar.

## Features

- **GitLab Integration**: Track commits, merge requests, code reviews, and issue activity
- **GitHub Integration**: Track commits, pull requests, code reviews, and issue activity
- **Dual Git Support**: Use GitLab, GitHub, or both simultaneously
- **Google Calendar**: Fetch meeting information with OAuth2 authentication
- **Outlook Calendar**: Fetch calendar events with Microsoft Graph API
- **Activity Caching**: Smart caching for improved performance
- **Secure Token Storage**: OAuth tokens stored securely in your home directory

## Installation

### Via npx (Recommended)

```bash
npx activity-collector-mcp
```

### Via npm

```bash
npm install -g activity-collector-mcp
```

### From Source

```bash
git clone https://github.com/srdmathur/activity-collector-mcp.git
cd activity-collector-mcp
npm install
npm run build
```

## Configuration

### For Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "activity-collector": {
      "command": "npx",
      "args": ["activity-collector-mcp"]
    }
  }
}
```

### For Claude Code (VS Code)

Add to `~/Library/Application Support/Code/User/mcp.json`:

```json
{
  "servers": {
    "activity-collector": {
      "type": "stdio",
      "command": "npx",
      "args": ["activity-collector-mcp"]
    }
  }
}
```

### API Configuration

Create `~/.activity-collector-mcp-config.json`:

```json
{
  "gitlab": {
    "url": "https://gitlab.com"
  },
  "google": {
    "clientId": "YOUR_GOOGLE_CLIENT_ID",
    "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET",
    "redirectUri": "http://localhost:3000/oauth/callback"
  },
  "outlook": {
    "clientId": "YOUR_OUTLOOK_CLIENT_ID",
    "clientSecret": "YOUR_OUTLOOK_CLIENT_SECRET",
    "tenantId": "YOUR_TENANT_ID",
    "redirectUri": "http://localhost:3000/oauth/callback"
  }
}
```

## Usage

### First Time Setup

1. **Check authentication status**:
   ```
   Check my authentication status
   ```

2. **Configure GitLab**:
   ```
   Configure GitLab with token: YOUR_GITLAB_TOKEN
   ```

3. **Configure GitHub**:
   ```
   Configure GitHub with token: YOUR_GITHUB_TOKEN
   ```

4. **Configure Google Calendar** (Optional):
   ```
   Set up Google Calendar authentication
   ```

5. **Configure Outlook Calendar** (Optional):
   ```
   Set up Outlook Calendar authentication
   ```

### Fetching Activity Data

- **GitLab Activity**: `Fetch GitLab activity for 2024-12-05`
- **GitHub Activity**: `Fetch GitHub activity for last week`
- **Calendar Events**: `Fetch Google Calendar events for today`
- **Date Ranges**: `Fetch activity from 2024-12-01 to 2024-12-07`

## Available Tools (12)

### Service Configuration (6 tools)
- `configure_gitlab` - Set up GitLab personal access token
- `configure_github` - Set up GitHub personal access token
- `configure_google_calendar` - Start Google Calendar OAuth flow
- `google_calendar_callback` - Complete Google Calendar OAuth
- `configure_outlook_calendar` - Start Outlook Calendar OAuth flow
- `outlook_calendar_callback` - Complete Outlook Calendar OAuth

### Data Fetching (4 tools)
- `fetch_gitlab_activity` - Fetch GitLab activity for specific dates
- `fetch_github_activity` - Fetch GitHub activity for specific dates
- `fetch_google_calendar_events` - Fetch Google Calendar events
- `fetch_outlook_calendar_events` - Fetch Outlook Calendar events

### Utilities (2 tools)
- `check_authentication_status` - Check authentication for all services
- `clear_cache` - Clear cached activity data

## Getting API Credentials

### GitLab Personal Access Token
1. Go to GitLab → User Settings → Access Tokens
2. Create token with `read_api` and `read_repository` scopes

### GitHub Personal Access Token
1. Go to GitHub → Settings → Developer Settings → Personal Access Tokens
2. Generate token with `repo` and `read:user` scopes

### Google Calendar Credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create project and enable Google Calendar API
3. Create OAuth 2.0 Client ID credentials

### Outlook Calendar Credentials
1. Go to [Azure Portal](https://portal.azure.com/)
2. Register application in Azure AD
3. Add `Calendars.Read` permission
4. Create client secret

## Security

- Tokens stored in `~/.activity-collector-mcp-tokens.json` with restricted permissions (600)
- OAuth tokens automatically refreshed when expired
- Configuration file should not be committed to version control

## Companion MCP

This MCP works great with [Timesheet Assistant MCP](https://github.com/sharadmathuratthepsi/timesheet-mcp) for timesheet generation and PSI submission.

## License

MIT

## Contributing

Contributions welcome! Please open issues or submit pull requests.

## Author

Sharad Mathur (srdmathur@gmail.com)
