import fetch from 'node-fetch';

export interface GitLabOAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token: string;
  created_at: number;
}

export interface GitLabOAuthConfig {
  applicationId: string;
  secret: string;
  gitlabUrl?: string;
}

/**
 * Helper class for GitLab OAuth operations
 */
export class GitLabOAuth {
  private applicationId: string;
  private secret: string;
  private gitlabUrl: string;

  constructor(config: GitLabOAuthConfig) {
    this.applicationId = config.applicationId;
    this.secret = config.secret;
    this.gitlabUrl = config.gitlabUrl || 'https://gitlab.com';
  }

  /**
   * Generate GitLab OAuth authorization URL
   */
  getAuthUrl(redirectUri: string, scopes: string[] = ['read_api']): string {
    const params = new URLSearchParams({
      client_id: this.applicationId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
    });

    return `${this.gitlabUrl}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async getTokenFromCode(code: string, redirectUri: string): Promise<GitLabOAuthTokens> {
    const params = new URLSearchParams({
      client_id: this.applicationId,
      client_secret: this.secret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const response = await fetch(`${this.gitlabUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      let errorInfo = {
        status: response.status,
        statusText: response.statusText,
        error: '',
        error_description: '',
        redirectUri,
      };

      try {
        const errorData = await response.json();
        errorInfo.error = errorData.error || '';
        errorInfo.error_description = errorData.error_description || '';
      } catch {
        const errorText = await response.text();
        errorInfo.error_description = errorText;
      }

      const errorMessage = errorInfo.error_description || errorInfo.error || `HTTP ${response.status} ${response.statusText}`;
      throw new Error(`GitLab token exchange failed (${response.status}): ${errorMessage}

Debug Info:
- Status: ${response.status} ${response.statusText}
- Error: ${errorInfo.error || 'N/A'}
- Description: ${errorInfo.error_description || 'N/A'}
- Redirect URI used: ${redirectUri}
- GitLab URL: ${this.gitlabUrl}`);
    }

    const tokens = (await response.json()) as GitLabOAuthTokens;
    return tokens;
  }

  /**
   * Refresh an expired access token
   */
  async refreshToken(refreshToken: string): Promise<GitLabOAuthTokens> {
    const params = new URLSearchParams({
      client_id: this.applicationId,
      client_secret: this.secret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(`${this.gitlabUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to refresh GitLab token: ${error}`);
    }

    const tokens = (await response.json()) as GitLabOAuthTokens;
    return tokens;
  }
}
