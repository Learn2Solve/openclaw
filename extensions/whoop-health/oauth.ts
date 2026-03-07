import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

const WHOOP_SCOPES = [
  "read:recovery",
  "read:cycles",
  "read:sleep",
  "read:workout",
  "read:profile",
  "read:body_measurement",
  "offline",
].join(" ");

export type WhoopOAuthToken = {
  access: string;
  refresh: string;
  expires: number;
};

/**
 * Run OAuth2 authorization code flow for Whoop.
 * 1. Start a local HTTP server for the callback
 * 2. Open the browser to Whoop's auth page
 * 3. Wait for the redirect with the authorization code
 * 4. Exchange the code for tokens
 */
export async function loginWhoopOAuth(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  openUrl: (url: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  progress: { update: (message: string) => void; stop: (message?: string) => void };
}): Promise<WhoopOAuthToken> {
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(WHOOP_AUTH_URL);
  authUrl.searchParams.set("client_id", params.clientId);
  authUrl.searchParams.set("redirect_uri", params.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", WHOOP_SCOPES);
  authUrl.searchParams.set("state", state);

  // Start local callback server
  const { code, server } = await waitForCallback({
    redirectUri: params.redirectUri,
    expectedState: state,
    openUrl: params.openUrl,
    note: params.note,
    progress: params.progress,
    authUrl: authUrl.toString(),
  });

  server.close();

  // Exchange code for tokens
  params.progress.update("Exchanging authorization code for tokens...");

  const tokenRes = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(
      `Whoop token exchange failed (${tokenRes.status}): ${text || tokenRes.statusText}`,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.expires_in) {
    throw new Error("Whoop token response missing required fields.");
  }

  return {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token,
    expires: Date.now() + tokenData.expires_in * 1000,
  };
}

export async function refreshWhoopToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<WhoopOAuthToken> {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whoop token refresh failed (${res.status}): ${text || res.statusText}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || !data.refresh_token || !data.expires_in) {
    throw new Error("Whoop token refresh response missing required fields.");
  }

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

function waitForCallback(params: {
  redirectUri: string;
  expectedState: string;
  openUrl: (url: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  progress: { update: (message: string) => void };
  authUrl: string;
}): Promise<{ code: string; server: ReturnType<typeof createServer> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(params.redirectUri);
    const port = Number.parseInt(url.port || "18789", 10);
    const path = url.pathname;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url?.startsWith(path)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");
      const error = reqUrl.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Whoop OAuth failed</h2><p>You can close this tab.</p></body></html>",
        );
        reject(new Error(`Whoop OAuth error: ${error}`));
        return;
      }

      if (!code || state !== params.expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Invalid callback</h2></body></html>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>Whoop connected!</h2><p>You can close this tab and return to OpenClaw.</p></body></html>",
      );
      resolve({ code, server });
    });

    server.listen(port, "127.0.0.1", async () => {
      await params.note(
        `Open the following URL to authorize Whoop access:\n${params.authUrl}`,
        "Whoop OAuth",
      );
      params.progress.update("Waiting for Whoop authorization...");
      try {
        await params.openUrl(params.authUrl);
      } catch {
        // User will manually open the URL
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Whoop OAuth timed out (5 min)."));
    }, 300_000);
  });
}
