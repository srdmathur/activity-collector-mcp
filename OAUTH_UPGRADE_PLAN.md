# OAuth Upgrade Implementation Plan

## Overview
Upgrade Activity Collector MCP to use automated OAuth flow with built-in HTTP server for both Google Calendar and GitLab. This eliminates the need for users to manually copy authorization codes.

## Current State ✅

### Completed Components:

1. **HTTP Server Utility** ([src/utils/oauthServer.ts](src/utils/oauthServer.ts))
   - Auto-detects available port (8080-8090)
   - Captures OAuth callbacks automatically
   - Shows success/error page in browser
   - Handles timeout and error cases

2. **OAuth Flow Helper** ([src/utils/oauthFlow.ts](src/utils/oauthFlow.ts))
   - Combines server + browser opening
   - Cross-platform browser launch (macOS, Windows, Linux)
   - Returns authorization code automatically

3. **GitLab OAuth Helper** ([src/utils/gitlabOAuth.ts](src/utils/gitlabOAuth.ts))
   - Generate authorization URL
   - Exchange code for tokens
   - Refresh expired tokens

4. **OAuth Credentials Config** ([src/config/oauth.ts](src/config/oauth.ts))
   - Placeholder for bundled credentials
   - Scopes defined for both services

5. **Updated Type Definitions** ([src/types/index.ts](src/types/index.ts))
   - GitLab tokens now support OAuth format (with refresh_token)
   - Backward compatible with string tokens (PAT)

6. **Updated Token Storage** ([src/utils/tokenStorage.ts](src/utils/tokenStorage.ts))
   - New methods: `getGitLabOAuthTokens()`, `setGitLabOAuthTokens()`
   - Backward compatible with existing PAT storage

## Next Steps 🚧

### Step 1: Register OAuth Applications

You need to create OAuth apps for both services with multiple redirect URIs.

#### Google Cloud OAuth App

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create project / Select existing
3. Enable "Google Calendar API"
4. Credentials → Create Credentials → OAuth Client ID
5. Application type: **"Desktop app"**
6. Add these Authorized redirect URIs:
   ```
   http://localhost:8080/callback
   http://localhost:8081/callback
   http://localhost:8082/callback
   http://localhost:8083/callback
   http://localhost:8084/callback
   http://localhost:8085/callback
   http://localhost:8086/callback
   http://localhost:8087/callback
   http://localhost:8088/callback
   http://localhost:8089/callback
   http://localhost:8090/callback
   ```
7. Copy **Client ID** and **Client Secret**

#### GitLab OAuth App

1. Go to [GitLab Applications](https://gitlab.com/-/profile/applications)
2. Add new application
3. Name: "Activity Collector MCP"
4. Redirect URIs (one per line):
   ```
   http://localhost:8080/callback
   http://localhost:8081/callback
   http://localhost:8082/callback
   http://localhost:8083/callback
   http://localhost:8084/callback
   http://localhost:8085/callback
   http://localhost:8086/callback
   http://localhost:8087/callback
   http://localhost:8088/callback
   http://localhost:8089/callback
   http://localhost:8090/callback
   ```
5. Scopes: **read_api**
6. Save
7. Copy **Application ID** and **Secret**

### Step 2: Update OAuth Credentials File

Edit [src/config/oauth.ts](src/config/oauth.ts) and replace placeholders:

```typescript
export const BUNDLED_OAUTH_CREDENTIALS = {
  google: {
    clientId: 'YOUR_ACTUAL_CLIENT_ID.apps.googleusercontent.com',
    clientSecret: 'YOUR_ACTUAL_CLIENT_SECRET',
  },
  gitlab: {
    applicationId: 'YOUR_ACTUAL_APPLICATION_ID',
    secret: 'YOUR_ACTUAL_SECRET',
  },
};
```

### Step 3: Add New MCP Tools

Need to add two new tools to [src/index.ts](src/index.ts):

#### Tool 1: `authenticate_google`
- **Description**: "Authenticate with Google Calendar using automated OAuth flow. Opens browser automatically and captures authorization."
- **Input**: None required
- **Output**: Success message with token info
- **Implementation**:
  1. Import BUNDLED_OAUTH_CREDENTIALS and runOAuthFlow
  2. Start OAuth server
  3. Generate auth URL with dynamic redirect URI
  4. Open browser
  5. Wait for callback
  6. Exchange code for tokens
  7. Save tokens
  8. Initialize Google Calendar integration

#### Tool 2: `authenticate_gitlab`
- **Description**: "Authenticate with GitLab using automated OAuth flow. Opens browser automatically and captures authorization."
- **Input**: Optional `gitlab_url` (default: 'https://gitlab.com')
- **Output**: Success message with token info
- **Implementation**:
  1. Import BUNDLED_OAUTH_CREDENTIALS, GitLabOAuth, runOAuthFlow
  2. Create GitLabOAuth instance
  3. Start OAuth server
  4. Generate auth URL with dynamic redirect URI
  5. Open browser
  6. Wait for callback
  7. Exchange code for tokens
  8. Save tokens
  9. Initialize GitLab integration

### Step 4: Update Existing Tools

#### Deprecate (but keep for backward compatibility):
- `configure_google_calendar` → Add note: "Deprecated. Use authenticate_google instead"
- `google_calendar_callback` → Keep for manual flow
- `configure_gitlab` → Keep for manual PAT configuration

#### Update `check_authentication_status`:
- Show whether GitLab is using OAuth or PAT
- Show token expiry information

### Step 5: Update Configuration

Edit [src/types/index.ts](src/types/index.ts) - Config interface:

Make Google and GitLab config sections **optional**:

```typescript
export interface Config {
  gitlab?: {
    url?: string;  // Optional, defaults to https://gitlab.com
  };
  google?: {
    // Optional custom OAuth app (overrides bundled credentials)
    clientId?: string;
    clientSecret?: string;
  };
  // ... other services
}
```

Update [src/index.ts](src/index.ts) - loadConfig method:

Make config file optional:

```typescript
private async loadConfig(): Promise<Config> {
  if (this.config) return this.config;

  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    this.config = JSON.parse(data);
  } catch (error) {
    // Config file optional - use defaults
    this.config = {};
  }

  return this.config;
}
```

### Step 6: Update README

Document the simplified setup:

```markdown
## Quick Setup

### Google Calendar

```bash
# No configuration needed!
```

Just run `authenticate_google` tool and follow the browser prompt.

### GitLab

```bash
# No configuration needed!
```

Just run `authenticate_gitlab` tool and follow the browser prompt.

### Advanced: Custom OAuth Apps

If you want to use your own OAuth applications, create `~/.activity-collector-mcp-config.json`:

```json
{
  "google": {
    "clientId": "your-id.apps.googleusercontent.com",
    "clientSecret": "your-secret"
  },
  "gitlab": {
    "url": "https://gitlab.example.com"  // For self-hosted GitLab
  }
}
```
```

## Benefits

### For Users:
- ✅ No OAuth app creation required
- ✅ No config file editing
- ✅ No manual code copying
- ✅ Consistent experience across services
- ✅ Works out of the box

### For You:
- ✅ Better user experience
- ✅ Fewer support questions
- ✅ Standard industry practice (VS Code, GitHub CLI do this)

## Testing Plan

1. **Test port auto-detection**:
   - Start server on 8080
   - Run authentication (should use 8081)

2. **Test Google OAuth flow**:
   - Run `authenticate_google`
   - Verify browser opens
   - Complete authorization
   - Verify tokens saved
   - Verify calendar fetch works

3. **Test GitLab OAuth flow**:
   - Run `authenticate_gitlab`
   - Verify browser opens
   - Complete authorization
   - Verify tokens saved
   - Verify activity fetch works

4. **Test error handling**:
   - User denies authorization
   - Network timeout
   - Invalid credentials
   - All ports busy (8080-8090)

5. **Test backward compatibility**:
   - Existing PAT tokens still work
   - Manual OAuth flow still works
   - Config file still works

## Security Considerations

### Is it safe to bundle OAuth credentials?

**Yes**, for desktop/CLI applications:

1. **OAuth Security Model**: Google and GitLab know desktop apps can't keep secrets truly secret
2. **User Authorization Required**: Even with client secret, each user must explicitly authorize access
3. **Industry Standard**: VS Code, GitHub CLI, Heroku CLI all bundle credentials
4. **What's Protected**: User's authorization is what matters, not the client secret
5. **Attack Surface**: An attacker with credentials still can't access any user data without that user authorizing them

### Alternatives Considered:

1. **Device Flow (RFC 8628)**: Not supported by Google for Calendar API
2. **PKCE Flow**: Requires more complex implementation, marginal security benefit for CLI apps
3. **User-created Apps**: Too complex for most users, high friction

## Implementation Status

- [x] HTTP server utility with port detection
- [x] OAuth flow helper with browser opening
- [x] GitLab OAuth helper
- [x] OAuth credentials config
- [x] Type definitions updated
- [x] Token storage updated
- [ ] Register OAuth applications (requires your action)
- [ ] Update OAuth credentials file
- [ ] Add authenticate_google tool
- [ ] Add authenticate_gitlab tool
- [ ] Update config requirements
- [ ] Test authentication flows
- [ ] Update documentation
- [ ] Build and publish

## Questions?

Before proceeding with implementation, please:

1. Register the OAuth apps (see Step 1)
2. Provide the credentials so I can update [src/config/oauth.ts](src/config/oauth.ts)
3. Let me know if you want me to proceed with Steps 3-6
