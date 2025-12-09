import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { URL } from 'url';

export interface OAuthCallbackResult {
  code?: string;
  error?: string;
  state?: string;
}

export interface OAuthServerOptions {
  startPort?: number;
  endPort?: number;
  timeout?: number; // milliseconds to wait for callback
}

/**
 * Starts a temporary HTTP server to capture OAuth callbacks
 * Automatically finds an available port in the specified range
 */
export class OAuthServer {
  private server: Server | null = null;
  private port: number | null = null;
  private callbackPromise: Promise<OAuthCallbackResult> | null = null;
  private callbackResolve: ((result: OAuthCallbackResult) => void) | null = null;

  /**
   * Start the OAuth callback server
   * Returns the port number it's listening on
   */
  async start(options: OAuthServerOptions = {}): Promise<number> {
    const startPort = options.startPort || 8080;
    const endPort = options.endPort || 8090;
    const timeout = options.timeout || 120000; // 2 minutes default

    // Create promise that will be resolved when callback is received
    this.callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
      this.callbackResolve = resolve;

      // Set timeout
      setTimeout(() => {
        reject(new Error('OAuth callback timeout - no response received'));
      }, timeout);
    });

    // Try to find an available port
    for (let port = startPort; port <= endPort; port++) {
      try {
        await this.tryStartServer(port);
        this.port = port;
        return port;
      } catch (error: any) {
        if (port === endPort) {
          throw new Error(
            `No available ports found in range ${startPort}-${endPort}. ` +
            `Please close other applications using these ports and try again.`
          );
        }
        // Try next port
        continue;
      }
    }

    throw new Error('Failed to start OAuth server');
  }

  /**
   * Wait for the OAuth callback
   * Automatically stops the server after receiving the callback
   */
  async waitForCallback(): Promise<OAuthCallbackResult> {
    if (!this.callbackPromise) {
      throw new Error('Server not started. Call start() first.');
    }

    try {
      const result = await this.callbackPromise;
      return result;
    } finally {
      await this.stop();
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        this.server = null;
        this.port = null;
      });
    }
  }

  /**
   * Get the current port (null if not started)
   */
  getPort(): number | null {
    return this.port;
  }

  /**
   * Try to start server on a specific port
   */
  private tryStartServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use`));
        } else {
          reject(err);
        }
      });

      this.server.listen(port, 'localhost', () => {
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!req.url) {
      this.sendResponse(res, 400, 'Bad Request');
      return;
    }

    const url = new URL(req.url, `http://localhost:${this.port}`);

    // Only handle /callback path
    if (url.pathname !== '/callback') {
      this.sendResponse(res, 404, 'Not Found');
      return;
    }

    // Extract OAuth parameters from query string
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');

    if (error) {
      // OAuth error
      const errorDescription = url.searchParams.get('error_description') || error;
      this.sendResponse(
        res,
        400,
        'Authentication Failed',
        `<p>Error: ${this.escapeHtml(errorDescription)}</p>`
      );

      if (this.callbackResolve) {
        this.callbackResolve({ error, state: state || undefined });
      }
    } else if (code) {
      // Success
      this.sendResponse(
        res,
        200,
        'Authentication Successful',
        '<p>You have been successfully authenticated!</p><p>You can close this window and return to your terminal.</p>'
      );

      if (this.callbackResolve) {
        this.callbackResolve({ code, state: state || undefined });
      }
    } else {
      // Missing parameters
      this.sendResponse(
        res,
        400,
        'Bad Request',
        '<p>Missing authorization code</p>'
      );

      if (this.callbackResolve) {
        this.callbackResolve({ error: 'missing_code' });
      }
    }
  }

  /**
   * Send HTTP response with HTML page
   */
  private sendResponse(
    res: ServerResponse,
    statusCode: number,
    title: string,
    body: string = ''
  ): void {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${this.escapeHtml(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 3rem;
      border-radius: 1rem;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
      text-align: center;
      max-width: 500px;
    }
    h1 {
      color: #333;
      margin-top: 0;
    }
    p {
      color: #666;
      line-height: 1.6;
    }
    .success {
      color: #10b981;
      font-size: 4rem;
      margin-bottom: 1rem;
    }
    .error {
      color: #ef4444;
      font-size: 4rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="${statusCode === 200 ? 'success' : 'error'}">
      ${statusCode === 200 ? '✓' : '✗'}
    </div>
    <h1>${this.escapeHtml(title)}</h1>
    ${body}
  </div>
</body>
</html>`;

    res.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}
