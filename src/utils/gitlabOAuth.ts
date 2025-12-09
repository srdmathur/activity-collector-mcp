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
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error_description || errorData.error || errorMessage;
      } catch {
        const errorText = await response.text();
        if (errorText) errorMessage = errorText;
      }
      throw new Error(`Failed to get GitLab access token (${response.status}): ${errorMessage}`);
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
