/**
 * WeChat Official Account API client.
 *
 * Flow: access_token -> upload thumb -> create draft -> publish (async)
 *
 * Docs:
 * - https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html
 * - https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html
 * - https://developers.weixin.qq.com/doc/offiaccount/Publish/Publish.html
 */

const BASE = "https://api.weixin.qq.com/cgi-bin";

// ---- Access Token (cached in-memory, 7200s TTL) ----

let cachedAccessToken: { token: string; expiresAt: number } | undefined;

export async function getWechatAccessToken(appId: string, appSecret: string): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const url = `${BASE}/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    errcode?: number;
    errmsg?: string;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat token error (${data.errcode}): ${data.errmsg}`);
  }

  if (!data.access_token) {
    throw new Error("WeChat token response missing access_token");
  }

  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  };

  return cachedAccessToken.token;
}

// ---- Upload thumb image (permanent material) ----

export async function uploadThumbImage(
  token: string,
  imageBuffer: Buffer,
  filename: string,
): Promise<string> {
  const url = `${BASE}/material/add_material?access_token=${token}&type=thumb`;

  const form = new FormData();
  const blob = new Blob([imageBuffer], { type: "image/jpeg" });
  form.append("media", blob, filename);

  const res = await fetch(url, { method: "POST", body: form });
  const data = (await res.json()) as {
    media_id?: string;
    errcode?: number;
    errmsg?: string;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat upload error (${data.errcode}): ${data.errmsg}`);
  }
  if (!data.media_id) {
    throw new Error("WeChat upload response missing media_id");
  }
  return data.media_id;
}

// ---- Upload article content images ----

export async function uploadContentImage(
  token: string,
  imageBuffer: Buffer,
  filename: string,
): Promise<string> {
  const url = `${BASE}/media/uploadimg?access_token=${token}`;

  const form = new FormData();
  const blob = new Blob([imageBuffer], { type: "image/jpeg" });
  form.append("media", blob, filename);

  const res = await fetch(url, { method: "POST", body: form });
  const data = (await res.json()) as {
    url?: string;
    errcode?: number;
    errmsg?: string;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat image upload error (${data.errcode}): ${data.errmsg}`);
  }
  if (!data.url) {
    throw new Error("WeChat image upload response missing url");
  }
  return data.url;
}

// ---- Create Draft ----

export type WechatArticle = {
  title: string;
  content: string; // HTML content
  author?: string;
  digest?: string; // Summary (max 120 chars, auto-generated if omitted)
  thumb_media_id?: string; // Cover image media_id
  content_source_url?: string; // "Read original" link
  need_open_comment?: 0 | 1;
  only_fans_can_comment?: 0 | 1;
};

export async function createDraft(token: string, articles: WechatArticle[]): Promise<string> {
  const url = `${BASE}/draft/add?access_token=${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articles }),
  });
  const data = (await res.json()) as {
    media_id?: string;
    errcode?: number;
    errmsg?: string;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat draft error (${data.errcode}): ${data.errmsg}`);
  }
  if (!data.media_id) {
    throw new Error("WeChat draft response missing media_id");
  }
  return data.media_id;
}

// ---- Publish Draft ----

export async function publishDraft(token: string, mediaId: string): Promise<string> {
  const url = `${BASE}/freepublish/submit?access_token=${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media_id: mediaId }),
  });
  const data = (await res.json()) as {
    publish_id?: string;
    errcode?: number;
    errmsg?: string;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat publish error (${data.errcode}): ${data.errmsg}`);
  }
  if (!data.publish_id) {
    throw new Error("WeChat publish response missing publish_id");
  }
  return data.publish_id;
}

// ---- Check Publish Status ----

export type PublishStatus = {
  publish_id: string;
  publish_status: 0 | 1 | 2 | 3; // 0=success, 1=publishing, 2=original failed, 3=regular failed
  article_id?: string;
  article_detail?: {
    count: number;
    item: Array<{
      idx: number;
      article_url: string;
    }>;
  };
  fail_idx?: number[];
};

export async function getPublishStatus(token: string, publishId: string): Promise<PublishStatus> {
  const url = `${BASE}/freepublish/get?access_token=${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const data = (await res.json()) as PublishStatus & {
    errcode?: number;
    errmsg?: string;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat status error (${data.errcode}): ${data.errmsg}`);
  }
  return data;
}

// ---- Get Draft List ----

export type WechatDraftItem = {
  media_id: string;
  content: {
    news_item: Array<{
      title: string;
      digest: string;
      content: string;
      update_time: number;
    }>;
  };
  update_time: number;
};

export async function listWechatDrafts(
  token: string,
  offset = 0,
  count = 10,
): Promise<{ total_count: number; item: WechatDraftItem[] }> {
  const url = `${BASE}/draft/batchget?access_token=${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset, count, no_content: 1 }),
  });
  const data = (await res.json()) as {
    total_count?: number;
    item?: WechatDraftItem[];
    errcode?: number;
    errmsg?: string;
  };

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat draft list error (${data.errcode}): ${data.errmsg}`);
  }
  return {
    total_count: data.total_count ?? 0,
    item: data.item ?? [],
  };
}
