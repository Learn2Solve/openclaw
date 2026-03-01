import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, ProviderAuthContext } from "openclaw/plugin-sdk";
import { saveDraft, getDraft, listDrafts, deleteDraft } from "./src/draft-store.js";
import { twitterCharCount } from "./src/format-utils.js";
import { formatSubstack } from "./src/substack/format.js";
import { postTweet, postThread, getMe } from "./src/twitter/api.js";
import { loginTwitterOAuth, refreshTwitterToken } from "./src/twitter/oauth.js";
import { splitThread, formatThreadPreview } from "./src/twitter/thread.js";
import type { ContentPublishConfig, PlatformId, TwitterToken } from "./src/types.js";
import {
  getWechatAccessToken,
  createDraft as createWechatDraft,
  publishDraft as publishWechatDraft,
  getPublishStatus,
  listWechatDrafts,
} from "./src/wechat/api.js";
import { formatWechat } from "./src/wechat/format.js";
import { formatXiaohongshu } from "./src/xiaohongshu/format.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

const PROVIDER_ID = "twitter";
const PROVIDER_LABEL = "Twitter/X";
const CALLBACK_PATH = "/api/twitter/callback";

const PLATFORM_LABELS: Record<PlatformId, string> = {
  twitter: "Twitter/X",
  substack: "Substack",
  wechat: "WeChat",
  xiaohongshu: "Xiaohongshu",
};

// In-memory token store (refreshed per gateway lifecycle)
let cachedToken: TwitterToken | undefined;

async function getAccessToken(
  config: ContentPublishConfig,
  store: ReturnType<typeof getAuthStore>,
): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) {
    return cachedToken.access;
  }

  const saved = store.get();
  if (saved && config.twitter) {
    try {
      const refreshed = await refreshTwitterToken({
        clientId: config.twitter.clientId,
        clientSecret: config.twitter.clientSecret,
        refreshToken: saved.refresh,
      });
      cachedToken = refreshed;
      store.set(refreshed);
      return refreshed.access;
    } catch {
      cachedToken = undefined;
      store.clear();
    }
  }

  throw new Error(
    "Twitter not authenticated. Run `openclaw login twitter` to connect your X account.",
  );
}

function getAuthStore(_api: OpenClawPluginApi) {
  let token: TwitterToken | undefined;
  return {
    get: () => token,
    set: (t: TwitterToken) => {
      token = t;
      cachedToken = t;
    },
    clear: () => {
      token = undefined;
      cachedToken = undefined;
    },
  };
}

const contentPublishPlugin = {
  id: "content-publish",
  name: "Content Publish",
  description: "Draft and publish content to Twitter/X, Substack, WeChat, and Xiaohongshu",

  register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig as unknown as ContentPublishConfig;
    // Merge environment variables as fallbacks for sensitive credentials
    const config: ContentPublishConfig = {
      ...rawConfig,
      wechat:
        rawConfig?.wechat ??
        (process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET
          ? {
              appId: process.env.WECHAT_APP_ID,
              appSecret: process.env.WECHAT_APP_SECRET,
              author: process.env.WECHAT_AUTHOR,
            }
          : undefined),
      twitter:
        rawConfig?.twitter ??
        (process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET
          ? {
              clientId: process.env.TWITTER_CLIENT_ID,
              clientSecret: process.env.TWITTER_CLIENT_SECRET,
            }
          : undefined),
      defaultPlatform:
        rawConfig?.defaultPlatform ??
        (process.env.CONTENT_PUBLISH_DEFAULT_PLATFORM as ContentPublishConfig["defaultPlatform"]) ??
        undefined,
    };
    const store = getAuthStore(api);
    const hasTwitter = !!(config?.twitter?.clientId && config?.twitter?.clientSecret);

    // ---- OAuth provider (Twitter) ----
    if (hasTwitter) {
      api.registerProvider({
        id: PROVIDER_ID,
        label: PROVIDER_LABEL,
        aliases: ["twitter", "x"],
        auth: [
          {
            id: "oauth",
            label: "Twitter OAuth 2.0 (PKCE)",
            hint: "Connect your X/Twitter account",
            kind: "custom",
            run: async (ctx: ProviderAuthContext) => {
              const progress = ctx.prompter.progress("Starting Twitter OAuth...");
              try {
                const redirectUri = `http://localhost:18790${CALLBACK_PATH}`;
                const token = await loginTwitterOAuth({
                  clientId: config.twitter!.clientId,
                  clientSecret: config.twitter!.clientSecret,
                  redirectUri,
                  openUrl: ctx.openUrl,
                  note: ctx.prompter.note,
                  progress,
                });

                store.set(token);
                progress.stop("Twitter/X connected");

                return {
                  profiles: [
                    {
                      profileId: `${PROVIDER_ID}:default`,
                      credential: {
                        type: "token",
                        provider: PROVIDER_ID,
                        token: token.access,
                      },
                    },
                  ],
                  notes: [
                    "Twitter/X OAuth connected. Tokens auto-refresh.",
                    "Re-run `openclaw login twitter` if token refresh fails.",
                  ],
                };
              } catch (err) {
                progress.stop("Twitter OAuth failed");
                throw err;
              }
            },
          },
        ],
      });
    }

    // ---- Tool: publish_twitter ----
    api.registerTool({
      name: "publish_twitter",
      label: "Publish to Twitter/X",
      description:
        "Post a tweet or thread to Twitter/X. Auto-detects single tweet vs thread based on length. " +
        "Use dryRun=true to preview the thread without posting.",
      parameters: Type.Object({
        content: Type.String({ description: "The content to publish" }),
        mode: Type.Optional(
          Type.Unsafe<"single" | "thread">({
            type: "string",
            enum: ["single", "thread"],
            description: "Force single tweet or thread mode. Auto-detects if omitted.",
          }),
        ),
        dryRun: Type.Optional(
          Type.Boolean({
            description: "If true, return formatted preview without posting",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { content, mode, dryRun } = params as {
          content: string;
          mode?: "single" | "thread";
          dryRun?: boolean;
        };

        const isSingle =
          mode === "single" || (mode !== "thread" && twitterCharCount(content) <= 280);

        if (isSingle) {
          const charCount = twitterCharCount(content);
          if (charCount > 280) {
            return textResult(
              `Content is ${charCount} chars (max 280). Use mode="thread" to post as a thread, or shorten the content.`,
            );
          }

          if (dryRun) {
            return textResult(`[DRY RUN] Single tweet (${charCount} chars):\n\n${content}`);
          }

          if (!hasTwitter) {
            return textResult(
              "Twitter not configured. Add twitter.clientId and twitter.clientSecret to plugin config.",
            );
          }

          const accessToken = await getAccessToken(config, store);
          const result = await postTweet(accessToken, content);
          let url = `https://x.com/i/status/${result.data.id}`;
          try {
            const me = await getMe(accessToken);
            url = `https://x.com/${me.username}/status/${result.data.id}`;
          } catch {
            // Fall back to generic URL
          }
          return textResult(`Published to X: ${url}`);
        }

        // Thread mode
        const tweets = splitThread(content);

        if (dryRun) {
          return textResult(
            `[DRY RUN] Thread preview (${tweets.length} tweets):\n\n${formatThreadPreview(tweets)}`,
          );
        }

        if (!hasTwitter) {
          return textResult(
            "Twitter not configured. Add twitter.clientId and twitter.clientSecret to plugin config.",
          );
        }

        const accessToken = await getAccessToken(config, store);
        const result = await postThread(accessToken, tweets);
        let username = "i";
        try {
          const me = await getMe(accessToken);
          username = me.username;
        } catch {
          // Fall back to generic URL
        }
        const url = `https://x.com/${username}/status/${result.firstTweetId}`;
        return textResult(`Published thread to X (${tweets.length} tweets): ${url}`);
      },
    });

    // ---- Tool: publish_wechat ----
    const hasWechat = !!(config?.wechat?.appId && config?.wechat?.appSecret);

    api.registerTool({
      name: "publish_wechat",
      label: "Publish to WeChat Official Account",
      description:
        "Publish an article to WeChat Official Account (公众号). " +
        "Creates a draft and optionally publishes it. " +
        "Use dryRun=true to create draft only without publishing. " +
        "Use action='status' with publishId to check publish status. " +
        "Use action='list' to list existing drafts.",
      parameters: Type.Object({
        action: Type.Optional(
          Type.Unsafe<"publish" | "draft" | "status" | "list">({
            type: "string",
            enum: ["publish", "draft", "status", "list"],
            description:
              "Action: 'publish' (default) creates draft + publishes, " +
              "'draft' creates draft only, " +
              "'status' checks publish status, " +
              "'list' lists existing drafts",
          }),
        ),
        title: Type.Optional(
          Type.String({ description: "Article title (required for publish/draft)" }),
        ),
        content: Type.Optional(
          Type.String({
            description:
              "Article content in Markdown or HTML. Will be auto-formatted with inline styles for WeChat.",
          }),
        ),
        author: Type.Optional(Type.String({ description: "Author name (falls back to config)" })),
        digest: Type.Optional(
          Type.String({
            description: "Article summary (max 120 chars, auto-generated if omitted)",
          }),
        ),
        sourceUrl: Type.Optional(Type.String({ description: "URL for 'Read original' link" })),
        publishId: Type.Optional(Type.String({ description: "Publish ID for status check" })),
        dryRun: Type.Optional(
          Type.Boolean({ description: "If true, return formatted preview without creating draft" }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          action = "publish",
          title,
          content,
          author,
          digest,
          sourceUrl,
          publishId,
          dryRun,
        } = params as {
          action?: "publish" | "draft" | "status" | "list";
          title?: string;
          content?: string;
          author?: string;
          digest?: string;
          sourceUrl?: string;
          publishId?: string;
          dryRun?: boolean;
        };

        if (!hasWechat) {
          return textResult(
            "WeChat not configured. Add wechat.appId and wechat.appSecret to the content-publish plugin config.",
          );
        }

        // -- Status check --
        if (action === "status") {
          if (!publishId) {
            return textResult("publishId is required for status check.");
          }
          try {
            const token = await getWechatAccessToken(
              config.wechat!.appId,
              config.wechat!.appSecret,
            );
            const status = await getPublishStatus(token, publishId);
            const statusLabels: Record<number, string> = {
              0: "Published successfully",
              1: "Publishing in progress",
              2: "Original content check failed",
              3: "Publish failed",
            };
            const label =
              statusLabels[status.publish_status] ?? `Unknown (${status.publish_status})`;
            let result = `Publish status: ${label}`;
            if (status.article_detail?.item?.length) {
              const urls = status.article_detail.item.map((i) => i.article_url).join("\n");
              result += `\nArticle URLs:\n${urls}`;
            }
            if (status.fail_idx?.length) {
              result += `\nFailed articles: ${status.fail_idx.join(", ")}`;
            }
            return textResult(result);
          } catch (err) {
            return textResult(
              `Failed to check status: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // -- List drafts --
        if (action === "list") {
          try {
            const token = await getWechatAccessToken(
              config.wechat!.appId,
              config.wechat!.appSecret,
            );
            const drafts = await listWechatDrafts(token, 0, 20);
            if (drafts.total_count === 0) {
              return textResult("No drafts in WeChat Official Account.");
            }
            const lines = drafts.item.map((d) => {
              const firstArticle = d.content.news_item[0];
              const t = firstArticle?.title ?? "(untitled)";
              const date = new Date(d.update_time * 1000)
                .toISOString()
                .slice(0, 16)
                .replace("T", " ");
              return `  ${d.media_id} - ${t} (${date})`;
            });
            return textResult(`WeChat drafts (${drafts.total_count} total):\n${lines.join("\n")}`);
          } catch (err) {
            return textResult(
              `Failed to list drafts: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // -- Publish / Draft --
        if (!title) {
          return textResult("title is required for creating a WeChat article.");
        }
        if (!content) {
          return textResult("content is required for creating a WeChat article.");
        }

        const htmlContent = formatWechat(content, undefined); // title rendered separately by WeChat

        if (dryRun) {
          return textResult(
            `[DRY RUN] WeChat article preview:\n\nTitle: ${title}\nAuthor: ${author ?? config.wechat?.author ?? "(default)"}\nDigest: ${digest ?? "(auto)"}\n\nHTML content (${htmlContent.length} chars):\n${htmlContent.slice(0, 500)}${htmlContent.length > 500 ? "..." : ""}`,
          );
        }

        try {
          const token = await getWechatAccessToken(config.wechat!.appId, config.wechat!.appSecret);

          const article = {
            title,
            content: htmlContent,
            author: author ?? config.wechat?.author,
            digest: digest?.slice(0, 120),
            content_source_url: sourceUrl,
            need_open_comment: 1 as const,
          };

          const mediaId = await createWechatDraft(token, [article]);

          if (action === "draft") {
            return textResult(
              `WeChat draft created.\nMedia ID: ${mediaId}\nTitle: ${title}\n\nUse publish_wechat with action='publish' and this media_id to publish, or publish manually at mp.weixin.qq.com.`,
            );
          }

          // Publish
          const pubId = await publishWechatDraft(token, mediaId);
          return textResult(
            `WeChat article submitted for publishing.\nPublish ID: ${pubId}\nTitle: ${title}\n\nPublishing is async. Use publish_wechat with action='status' and publishId='${pubId}' to check progress.`,
          );
        } catch (err) {
          return textResult(
            `Failed to publish to WeChat: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    });

    // ---- Tool: format_content ----
    api.registerTool({
      name: "format_content",
      label: "Format Content",
      description:
        "Format content for a specific platform without publishing. " +
        "Twitter: thread preview with char counts. Substack: semantic HTML. " +
        "WeChat: inline-styled HTML. Xiaohongshu: emoji bullets + hashtags.",
      parameters: Type.Object({
        content: Type.String({ description: "The content to format" }),
        platform: Type.Unsafe<PlatformId>({
          type: "string",
          enum: ["twitter", "substack", "wechat", "xiaohongshu"],
          description: "Target platform",
        }),
        title: Type.Optional(Type.String({ description: "Title (used for substack and wechat)" })),
      }),
      async execute(_toolCallId, params) {
        const { content, platform, title } = params as {
          content: string;
          platform: PlatformId;
          title?: string;
        };

        switch (platform) {
          case "twitter": {
            const tweets = splitThread(content);
            return textResult(
              `Formatted for Twitter/X (${tweets.length} tweet${tweets.length === 1 ? "" : "s"}):\n\n${formatThreadPreview(tweets)}`,
            );
          }
          case "substack": {
            const html = formatSubstack(content, title);
            return textResult(
              `Formatted for Substack (copy into editor at your publication):\n\n${html}`,
            );
          }
          case "wechat": {
            const html = formatWechat(content, title);
            return textResult(
              `Formatted for WeChat (copy into mp.weixin.qq.com editor):\n\n${html}`,
            );
          }
          case "xiaohongshu": {
            const formatted = formatXiaohongshu(content, title);
            return textResult(
              `Formatted for Xiaohongshu (${formatted.length}/1000 chars):\n\n${formatted}`,
            );
          }
          default:
            return textResult(`Unknown platform: ${platform as string}`);
        }
      },
    });

    // ---- Tool: save_draft ----
    api.registerTool({
      name: "save_draft",
      label: "Save Draft",
      description: "Save content as a draft for later publishing or formatting.",
      parameters: Type.Object({
        content: Type.String({ description: "The draft content" }),
        title: Type.Optional(Type.String({ description: "Draft title" })),
        platform: Type.Optional(
          Type.Unsafe<PlatformId>({
            type: "string",
            enum: ["twitter", "substack", "wechat", "xiaohongshu"],
            description: "Target platform for this draft",
          }),
        ),
        id: Type.Optional(
          Type.String({ description: "Draft ID to update (creates new if omitted)" }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { content, title, platform, id } = params as {
          content: string;
          title?: string;
          platform?: PlatformId;
          id?: string;
        };

        const stateDir = api.runtime.state.resolveStateDir();
        const draft = await saveDraft(stateDir, { content, title, platform, id });
        const platformLabel = draft.platform ? ` (${PLATFORM_LABELS[draft.platform]})` : "";
        return textResult(
          `Draft saved: ${draft.id}${platformLabel}\nTitle: ${draft.title ?? "(none)"}\nLength: ${draft.content.length} chars`,
        );
      },
    });

    // ---- Tool: list_drafts ----
    api.registerTool({
      name: "list_drafts",
      label: "List Drafts",
      description: "List all saved drafts.",
      parameters: Type.Object({}),
      async execute() {
        const stateDir = api.runtime.state.resolveStateDir();
        const drafts = await listDrafts(stateDir);
        if (drafts.length === 0) {
          return textResult("No drafts saved.");
        }
        const lines = drafts.map((d) => {
          const platform = d.platform ? ` [${d.platform}]` : "";
          const title = d.title ? ` - ${d.title}` : "";
          const date = new Date(d.updatedAt).toISOString().slice(0, 16).replace("T", " ");
          return `${d.id}${platform}${title} (${d.content.length} chars, ${date})`;
        });
        return textResult(`Drafts (${drafts.length}):\n${lines.join("\n")}`);
      },
    });

    // ---- Command: /draft ----
    api.registerCommand({
      name: "draft",
      description: "Start a draft workflow. Usage: /draft [platform]",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ?? "";
        const platform = args.toLowerCase() as PlatformId;
        const validPlatforms = ["twitter", "substack", "wechat", "xiaohongshu"];

        if (args && !validPlatforms.includes(platform)) {
          return {
            text: `Unknown platform: ${args}\nValid platforms: ${validPlatforms.join(", ")}`,
          };
        }

        const platformHint = platform
          ? `Platform set to ${PLATFORM_LABELS[platform]}.`
          : `Default platform: ${PLATFORM_LABELS[config?.defaultPlatform ?? "twitter"]}.`;

        return {
          text: [
            "Draft workflow started.",
            platformHint,
            "",
            "Discuss your topic, then ask the bot to:",
            '- "Draft a tweet about this"',
            '- "Format this for WeChat"',
            '- "Save this as a draft"',
            "",
            "The bot will use format_content and save_draft tools.",
          ].join("\n"),
        };
      },
    });

    // ---- Command: /publish ----
    api.registerCommand({
      name: "publish",
      description: "Publish content. Usage: /publish status | /publish last | /publish <draft_id>",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = tokens[0]?.toLowerCase() ?? "";

        if (!action || action === "help") {
          return {
            text: [
              "Publish commands:",
              "",
              "/publish status   - Show platform auth/config status",
              "/publish last     - Publish the most recent draft",
              "/publish <id>     - Publish a specific draft",
              "",
              "Twitter publishes via API. Other platforms output formatted text for copy-paste.",
            ].join("\n"),
          };
        }

        if (action === "status") {
          const twitterStatus = hasTwitter
            ? cachedToken
              ? "authenticated"
              : "configured (not authenticated - run `openclaw login twitter`)"
            : "not configured";

          const substackStatus = config?.substack?.publicationUrl
            ? `configured (${config.substack.publicationUrl})`
            : "not configured (format-only)";

          const wechatStatus = hasWechat
            ? `configured (appId: ${config!.wechat!.appId.slice(0, 8)}...)`
            : "not configured (format-only)";

          return {
            text: [
              "Platform status:",
              `  Twitter/X:    ${twitterStatus}`,
              `  WeChat:       ${wechatStatus}`,
              `  Substack:     ${substackStatus}`,
              "  Xiaohongshu:  format-only (copy-paste)",
              "",
              `Default platform: ${config?.defaultPlatform ?? "twitter"}`,
            ].join("\n"),
          };
        }

        // Publish a draft
        const stateDir = api.runtime.state.resolveStateDir();
        let draftId = action;

        if (action === "last") {
          const drafts = await listDrafts(stateDir);
          if (drafts.length === 0) {
            return { text: "No drafts available. Save a draft first." };
          }
          draftId = drafts[0]!.id;
        }

        const draft = await getDraft(stateDir, draftId);
        if (!draft) {
          return { text: `Draft not found: ${draftId}` };
        }

        const platform = draft.platform ?? config?.defaultPlatform ?? "twitter";

        if (platform === "twitter") {
          if (!hasTwitter) {
            return {
              text: "Twitter not configured. Add twitter.clientId and twitter.clientSecret to plugin config.",
            };
          }

          try {
            const accessToken = await getAccessToken(config, store);
            const isSingle = twitterCharCount(draft.content) <= 280;

            if (isSingle) {
              const result = await postTweet(accessToken, draft.content);
              let url = `https://x.com/i/status/${result.data.id}`;
              try {
                const me = await getMe(accessToken);
                url = `https://x.com/${me.username}/status/${result.data.id}`;
              } catch {}
              return { text: `Published to X: ${url}` };
            }

            const tweets = splitThread(draft.content);
            const result = await postThread(accessToken, tweets);
            let username = "i";
            try {
              const me = await getMe(accessToken);
              username = me.username;
            } catch {}
            const url = `https://x.com/${username}/status/${result.firstTweetId}`;
            return {
              text: `Published thread to X (${tweets.length} tweets): ${url}`,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { text: `Failed to publish to Twitter: ${msg}` };
          }
        }

        // Non-Twitter platforms: format and output for copy-paste
        let formatted: string;
        switch (platform) {
          case "substack":
            formatted = formatSubstack(draft.content, draft.title);
            return {
              text: `Formatted for Substack (copy into editor):\n\n${formatted}`,
            };
          case "wechat": {
            if (hasWechat && draft.title) {
              try {
                const token = await getWechatAccessToken(
                  config.wechat!.appId,
                  config.wechat!.appSecret,
                );
                const htmlContent = formatWechat(draft.content, undefined);
                const article = {
                  title: draft.title,
                  content: htmlContent,
                  author: config.wechat?.author,
                  need_open_comment: 1 as const,
                };
                const mediaId = await createWechatDraft(token, [article]);
                const pubId = await publishWechatDraft(token, mediaId);
                return {
                  text: `Published to WeChat (${draft.title}).\nPublish ID: ${pubId}\nUse /publish status to check progress.`,
                };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { text: `Failed to publish to WeChat: ${msg}` };
              }
            }
            formatted = formatWechat(draft.content, draft.title);
            return {
              text: `Formatted for WeChat (copy into mp.weixin.qq.com editor):\n\n${formatted}`,
            };
          }
          case "xiaohongshu":
            formatted = formatXiaohongshu(draft.content, draft.title);
            return {
              text: `Formatted for Xiaohongshu (${formatted.length}/1000 chars):\n\n${formatted}`,
            };
          default:
            return { text: `Unknown platform: ${platform}` };
        }
      },
    });

    // ---- Command: /drafts ----
    api.registerCommand({
      name: "drafts",
      description: "List or delete drafts. Usage: /drafts | /drafts delete <id>",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = tokens[0]?.toLowerCase() ?? "";
        const stateDir = api.runtime.state.resolveStateDir();

        if (action === "delete") {
          const id = tokens[1];
          if (!id) {
            return { text: "Usage: /drafts delete <id>" };
          }
          const deleted = await deleteDraft(stateDir, id);
          return { text: deleted ? `Draft ${id} deleted.` : `Draft not found: ${id}` };
        }

        const drafts = await listDrafts(stateDir);
        if (drafts.length === 0) {
          return { text: "No drafts saved." };
        }

        const lines = drafts.map((d) => {
          const platform = d.platform ? ` [${d.platform}]` : "";
          const title = d.title ? ` - ${d.title}` : "";
          const date = new Date(d.updatedAt).toISOString().slice(0, 16).replace("T", " ");
          return `  ${d.id}${platform}${title} (${d.content.length} chars, ${date})`;
        });

        return {
          text: [
            `Drafts (${drafts.length}):`,
            ...lines,
            "",
            "Use /drafts delete <id> to remove a draft.",
            "Use /publish <id> to publish a draft.",
          ].join("\n"),
        };
      },
    });

    const toolCount = 4 + (hasTwitter ? 1 : 0);
    api.logger.info(
      `content-publish: plugin registered (${toolCount} tools, 3 commands${hasTwitter ? ", twitter oauth" : ""}${hasWechat ? ", wechat api" : ""})`,
    );
  },
};

export default contentPublishPlugin;
