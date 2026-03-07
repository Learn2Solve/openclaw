import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TwitterToken } from "../types.js";

const TWITTER_AUTH_URL = "https://twitter.com/i/oauth2/authorize";
const TWITTER_TOKEN_URL = "https://api.x.com/2/oauth2/token";

const TWITTER_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"].join(" ");

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Run OAuth 2.0 PKCE flow for Twitter/X.
 * 1. Generate code_verifier + code_challenge (S256)
 * 2. Start local HTTP callback server
 * 3. Open browser to Twitter auth page
 * 4. Exchange code at token endpoint
 */
export async function loginTwitterOAuth(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  openUrl: (url: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  progress: { update: (message: string) => void; stop: (message?: string) => void };
}): Promise<TwitterToken> {
  const state = randomBytes(16).toString("hex");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const authUrl = new URL(TWITTER_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", params.clientId);
  authUrl.searchParams.set("redirect_uri", params.redirectUri);
  authUrl.searchParams.set("scope", TWITTER_SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const { code, server } = await waitForCallback({
    redirectUri: params.redirectUri,
    expectedState: state,
    openUrl: params.openUrl,
    note: params.note,
    progress: params.progress,
    authUrl: authUrl.toString(),
  });

  server.close();

  params.progress.update("Exchanging authorization code for tokens...");

  const tokenRes = await fetch(TWITTER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: params.redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(
      `Twitter token exchange failed (${tokenRes.status}): ${text || tokenRes.statusText}`,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.expires_in) {
    throw new Error("Twitter token response missing required fields.");
  }

  return {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token,
    expires: Date.now() + tokenData.expires_in * 1000,
  };
}

export async function refreshTwitterToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TwitterToken> {
  const res = await fetch(TWITTER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitter token refresh failed (${res.status}): ${text || res.statusText}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || !data.refresh_token || !data.expires_in) {
    throw new Error("Twitter token refresh response missing required fields.");
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
    const callbackPath = url.pathname;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url?.startsWith(callbackPath)) {
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
          "<html><body><h2>Twitter OAuth failed</h2><p>You can close this tab.</p></body></html>",
        );
        reject(new Error(`Twitter OAuth error: ${error}`));
        return;
      }

      if (!code || state !== params.expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Invalid callback</h2></body></html>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>Twitter/X connected!</h2><p>You can close this tab and return to OpenClaw.</p></body></html>",
      );
      resolve({ code, server });
    });

    server.listen(port, "127.0.0.1", async () => {
      await params.note(
        `Open the following URL to authorize Twitter/X access:\n${params.authUrl}`,
        "Twitter OAuth",
      );
      params.progress.update("Waiting for Twitter authorization...");
      try {
        await params.openUrl(params.authUrl);
      } catch {
        // User will manually open the URL
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Twitter OAuth timed out (5 min)."));
    }, 300_000);
  });
}
