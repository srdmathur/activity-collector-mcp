import { TokenStore } from '../types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

const TOKEN_FILE = path.join(homedir(), '.activity-collector-mcp-tokens.json');

export class TokenStorage {
  private tokens: TokenStore = {};

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(TOKEN_FILE, 'utf-8');
      this.tokens = JSON.parse(data);
    } catch (error) {
      // File doesn't exist yet, that's okay
      this.tokens = {};
    }
  }

  async save(): Promise<void> {
    await fs.writeFile(TOKEN_FILE, JSON.stringify(this.tokens, null, 2), {
      mode: 0o600, // Only owner can read/write
    });
  }

  getGitLabToken(): string | undefined {
    const gitlab = this.tokens.gitlab;
    if (typeof gitlab === 'string') {
      return gitlab;
    } else if (gitlab && typeof gitlab === 'object') {
      return gitlab.access_token;
    }
    return undefined;
  }

  getGitLabOAuthTokens(): TokenStore['gitlab'] | undefined {
    return this.tokens.gitlab;
  }

  async setGitLabToken(token: string): Promise<void> {
    this.tokens.gitlab = token;
    await this.save();
  }

  async setGitLabOAuthTokens(tokens: {
    access_token: string;
    refresh_token: string;
    created_at: number;
    expires_in?: number;
  }): Promise<void> {
    this.tokens.gitlab = tokens;
    await this.save();
  }

  getGitHubToken(): string | undefined {
    return this.tokens.github;
  }

  async setGitHubToken(token: string): Promise<void> {
    this.tokens.github = token;
    await this.save();
  }

  getGoogleTokens(): TokenStore['google'] | undefined {
    return this.tokens.google;
  }

  async setGoogleTokens(tokens: TokenStore['google']): Promise<void> {
    this.tokens.google = tokens;
    await this.save();
  }

  getOutlookTokens(): TokenStore['outlook'] | undefined {
    return this.tokens.outlook;
  }

  async setOutlookTokens(tokens: TokenStore['outlook']): Promise<void> {
    this.tokens.outlook = tokens;
    await this.save();
  }

  async clearAll(): Promise<void> {
    this.tokens = {};
    await this.save();
  }

  hasGitLabToken(): boolean {
    return !!this.tokens.gitlab;
  }

  hasGitHubToken(): boolean {
    return !!this.tokens.github;
  }

  hasGoogleTokens(): boolean {
    return !!this.tokens.google?.access_token;
  }

  hasOutlookTokens(): boolean {
    return !!this.tokens.outlook?.access_token;
  }
}
