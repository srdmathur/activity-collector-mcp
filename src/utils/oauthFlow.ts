import { OAuthServer } from './oauthServer.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Open a URL in the user's default browser
 */
async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      // macOS
      await execAsync(`open "${url}"`);
    } else if (platform === 'win32') {
      // Windows
      await execAsync(`start "" "${url}"`);
    } else {
      // Linux/Unix
      await execAsync(`xdg-open "${url}"`);
    }
  } catch (error) {
    console.error('Failed to open browser automatically:', error);
    console.log(`\nPlease open this URL manually in your browser:\n${url}\n`);
  }
}

export interface OAuthFlowResult {
  code?: string;
  error?: string;
  port: number;
}

/**
 * Run complete OAuth flow with built-in server and browser opening
 *
 * @param authUrl Base authorization URL (without redirect_uri)
 * @param authUrlBuilder Function that takes port and returns complete auth URL
 * @returns Authorization code or error
 */
export async function runOAuthFlow(
  authUrlBuilder: (redirectUri: string) => string
): Promise<OAuthFlowResult> {
  const server = new OAuthServer();

  try {
    // Start server and get available port
    const port = await server.start({
      startPort: 8080,
      endPort: 8090,
      timeout: 300000, // 5 minutes
    });

    console.log(`OAuth server started on port ${port}`);

    // Build redirect URI
    const redirectUri = `http://localhost:${port}/callback`;

    // Generate authorization URL
    const authUrl = authUrlBuilder(redirectUri);

    // Open browser
    console.log('Opening browser for authentication...');
    await openBrowser(authUrl);

    console.log('\nWaiting for authentication...');
    console.log('If the browser did not open automatically, please visit:');
    console.log(authUrl);
    console.log('');

    // Wait for callback
    const result = await server.waitForCallback();

    return {
      code: result.code,
      error: result.error,
      port,
    };
  } catch (error: any) {
    throw new Error(`OAuth flow failed: ${error.message}`);
  } finally {
    // Ensure server is stopped
    await server.stop();
  }
}
