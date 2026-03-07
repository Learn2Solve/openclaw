import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, ProviderAuthContext } from "openclaw/plugin-sdk";
import {
  formatCycle,
  formatRecovery,
  formatSleep,
  formatWorkout,
  getBody,
  getCycles,
  getProfile,
  getRecoveries,
  getSleeps,
  getWorkouts,
} from "./api.js";
import { loginWhoopOAuth, refreshWhoopToken } from "./oauth.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

const PROVIDER_ID = "whoop";
const PROVIDER_LABEL = "Whoop";
const CALLBACK_PATH = "/api/whoop/callback";

interface WhoopPluginConfig {
  clientId: string;
  clientSecret: string;
}

type WhoopToken = {
  access: string;
  refresh?: string;
  expires?: number;
};

const WHOOP_TOKEN_FILE = "whoop-health-oauth.json";

// In-memory token cache (backed by state file)
let cachedToken: WhoopToken | undefined;
let cachedTokenLoadPromise: Promise<WhoopToken | undefined> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function parseWhoopToken(value: unknown): WhoopToken | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const access = readString(value.access) ?? readString(value.token);
  if (!access) {
    return undefined;
  }

  return {
    access,
    refresh: readString(value.refresh),
    expires: readNumber(value.expires) ?? readNumber(value.expiresAt),
  };
}

function normalizeAgentId(raw: unknown): string {
  return (typeof raw === "string" ? raw.trim().toLowerCase() : "") || "main";
}

function resolveDefaultAgentId(config: OpenClawPluginApi["config"]): string {
  const list = Array.isArray(config.agents?.list) ? config.agents.list : [];
  if (list.length === 0) {
    return "main";
  }
  const defaultEntry = list.find((entry) => entry?.default) ?? list[0];
  return normalizeAgentId(defaultEntry?.id);
}

function resolveTokenStorePath(api: OpenClawPluginApi): string {
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  return path.join(stateDir, "credentials", WHOOP_TOKEN_FILE);
}

function extractWhoopTokenFromAuthStore(value: unknown): WhoopToken | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const profiles = isRecord(value.profiles) ? value.profiles : value;
  for (const credential of Object.values(profiles)) {
    if (!isRecord(credential)) {
      continue;
    }

    const provider = readString(credential.provider);
    if (provider !== PROVIDER_ID) {
      continue;
    }

    const type = readString(credential.type);
    if (type === "oauth") {
      const oauth = parseWhoopToken({
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
      });
      if (oauth) {
        return oauth;
      }
      continue;
    }

    if (type === "token") {
      const token = parseWhoopToken({
        token: credential.token,
        expires: credential.expires,
      });
      if (token) {
        return token;
      }
      continue;
    }

    const fallback = parseWhoopToken(credential);
    if (fallback) {
      return fallback;
    }
  }

  return undefined;
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function writeTokenFile(api: OpenClawPluginApi, token?: WhoopToken): Promise<void> {
  const tokenPath = resolveTokenStorePath(api);
  if (!token) {
    await fs.rm(tokenPath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`, "utf8");
}

async function readAuthStoreFallback(api: OpenClawPluginApi): Promise<WhoopToken | undefined> {
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const defaultAgentId = resolveDefaultAgentId(api.config);
  const candidates = [
    path.join(stateDir, "agents", defaultAgentId, "agent", "auth-profiles.json"),
    path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
    path.join(stateDir, "credentials", "auth-profiles.json"),
  ];

  for (const candidate of candidates) {
    const parsed = await readJsonFile(candidate);
    if (!parsed) {
      continue;
    }
    const token = extractWhoopTokenFromAuthStore(parsed);
    if (token) {
      return token;
    }
  }

  return undefined;
}

async function loadPersistedToken(api: OpenClawPluginApi): Promise<WhoopToken | undefined> {
  const persisted = parseWhoopToken(await readJsonFile(resolveTokenStorePath(api)));
  if (persisted) {
    return persisted;
  }

  // Backward compatibility: hydrate from auth-profiles if available.
  const fallback = await readAuthStoreFallback(api);
  if (fallback) {
    try {
      await writeTokenFile(api, fallback);
    } catch (error) {
      api.logger.warn(`whoop-health: failed to persist token fallback (${String(error)})`);
    }
  }
  return fallback;
}

async function getAccessToken(
  config: WhoopPluginConfig,
  store: ReturnType<typeof getAuthStore>,
): Promise<string> {
  const now = Date.now();

  if (cachedToken && (!cachedToken.expires || cachedToken.expires > now + 60_000)) {
    return cachedToken.access;
  }

  const saved = await store.get();
  if (saved) {
    if (!saved.expires || saved.expires > now + 60_000) {
      cachedToken = saved;
      return saved.access;
    }

    if (saved.refresh) {
      try {
        const refreshed = await refreshWhoopToken({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: saved.refresh,
        });
        await store.set(refreshed);
        return refreshed.access;
      } catch {
        cachedToken = undefined;
        await store.clear();
      }
    }

    // Last-resort: non-refreshable token from auth-profiles.
    return saved.access;
  }

  throw new Error(
    "Whoop not authenticated. Run `openclaw models auth login --provider whoop` to connect your Whoop account.",
  );
}

function getAuthStore(api: OpenClawPluginApi) {
  return {
    get: async () => {
      if (cachedToken) {
        return cachedToken;
      }
      cachedTokenLoadPromise ??= loadPersistedToken(api);
      const loaded = await cachedTokenLoadPromise;
      cachedTokenLoadPromise = undefined;
      cachedToken = loaded;
      return loaded;
    },
    set: async (token: WhoopToken) => {
      cachedToken = token;
      await writeTokenFile(api, token);
    },
    clear: async () => {
      cachedToken = undefined;
      cachedTokenLoadPromise = undefined;
      await writeTokenFile(api, undefined);
    },
  };
}

const whoopPlugin = {
  id: "whoop-health",
  name: "Whoop Health",
  description: "Health data from Whoop wearable - recovery, sleep, strain, workouts",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as unknown as WhoopPluginConfig;
    if (!config?.clientId || !config?.clientSecret) {
      api.logger.warn("whoop-health: missing clientId or clientSecret in plugin config");
      return;
    }

    const store = getAuthStore(api);

    // ---- OAuth provider registration ----
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/plugins/whoop",
      aliases: ["whoop"],
      auth: [
        {
          id: "oauth",
          label: "Whoop OAuth",
          hint: "Connect your Whoop account",
          kind: "custom",
          run: async (ctx: ProviderAuthContext) => {
            const progress = ctx.prompter.progress("Starting Whoop OAuth...");
            try {
              const redirectUri = `http://localhost:18790${CALLBACK_PATH}`;
              const token = await loginWhoopOAuth({
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                redirectUri,
                openUrl: ctx.openUrl,
                note: ctx.prompter.note,
                progress,
              });

              await store.set(token);
              progress.stop("Whoop connected");

              return {
                profiles: [
                  {
                    profileId: `${PROVIDER_ID}:default`,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: token.access,
                      refresh: token.refresh,
                      expires: token.expires,
                    },
                  },
                ],
                notes: [
                  "Whoop OAuth connected. Tokens auto-refresh.",
                  "Re-run `openclaw models auth login --provider whoop` if token refresh fails.",
                ],
              };
            } catch (err) {
              progress.stop("Whoop OAuth failed");
              throw err;
            }
          },
        },
      ],
    });

    // ---- Tools ----

    api.registerTool({
      name: "whoop_recovery",
      label: "Whoop Recovery",
      description:
        "Get recovery score from Whoop. Returns recovery %, resting heart rate, HRV, SpO2, and skin temperature.",
      parameters: Type.Object({
        days: Type.Optional(
          Type.Number({
            description: "Number of recent recoveries to fetch (1-14)",
            minimum: 1,
            maximum: 14,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { days = 1 } = params as { days?: number };
        const accessToken = await getAccessToken(config, store);
        const recoveries = await getRecoveries(accessToken, days);
        if (recoveries.length === 0) {
          return textResult("No recovery data available.");
        }
        const text = recoveries.map(formatRecovery).join("\n---\n");
        return textResult(text);
      },
    });

    api.registerTool({
      name: "whoop_sleep",
      label: "Whoop Sleep",
      description:
        "Get sleep data from Whoop. Returns sleep stages (light, deep, REM), duration, efficiency, and respiratory rate.",
      parameters: Type.Object({
        days: Type.Optional(
          Type.Number({
            description: "Number of recent sleep records (1-14)",
            minimum: 1,
            maximum: 14,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { days = 1 } = params as { days?: number };
        const accessToken = await getAccessToken(config, store);
        const sleeps = await getSleeps(accessToken, days);
        if (sleeps.length === 0) {
          return textResult("No sleep data available.");
        }
        const text = sleeps.map(formatSleep).join("\n---\n");
        return textResult(text);
      },
    });

    api.registerTool({
      name: "whoop_workout",
      label: "Whoop Workouts",
      description:
        "Get workout data from Whoop. Returns strain score, heart rate zones, calories burned.",
      parameters: Type.Object({
        count: Type.Optional(
          Type.Number({ description: "Number of recent workouts (1-25)", minimum: 1, maximum: 25 }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { count = 5 } = params as { count?: number };
        const accessToken = await getAccessToken(config, store);
        const workouts = await getWorkouts(accessToken, count);
        if (workouts.length === 0) {
          return textResult("No workout data available.");
        }
        const text = workouts.map(formatWorkout).join("\n---\n");
        return textResult(text);
      },
    });

    api.registerTool({
      name: "whoop_strain",
      label: "Whoop Day Strain",
      description: "Get current day strain from Whoop. Returns strain score, calories, heart rate.",
      parameters: Type.Object({
        days: Type.Optional(
          Type.Number({
            description: "Number of recent cycles/days (1-14)",
            minimum: 1,
            maximum: 14,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { days = 1 } = params as { days?: number };
        const accessToken = await getAccessToken(config, store);
        const cycles = await getCycles(accessToken, days);
        if (cycles.length === 0) {
          return textResult("No cycle/strain data available.");
        }
        const text = cycles.map(formatCycle).join("\n---\n");
        return textResult(text);
      },
    });

    api.registerTool({
      name: "whoop_profile",
      label: "Whoop Profile",
      description: "Get Whoop user profile and body measurements.",
      parameters: Type.Object({}),
      async execute() {
        const accessToken = await getAccessToken(config, store);
        const [profile, body] = await Promise.all([getProfile(accessToken), getBody(accessToken)]);
        const text = [
          `Name: ${profile.first_name} ${profile.last_name}`,
          `Email: ${profile.email}`,
          `Height: ${(body.height_meter * 100).toFixed(1)} cm`,
          `Weight: ${body.weight_kilogram.toFixed(1)} kg`,
          `Max HR: ${body.max_heart_rate} bpm`,
        ].join("\n");
        return textResult(text);
      },
    });

    api.logger.info("whoop-health: plugin registered (5 tools)");
  },
};

export default whoopPlugin;
