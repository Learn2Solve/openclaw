export type PlatformId = "twitter" | "substack" | "wechat" | "xiaohongshu";

export type Draft = {
  id: string;
  content: string;
  title?: string;
  platform?: PlatformId;
  createdAt: number;
  updatedAt: number;
};

export type DraftFile = {
  version: 1;
  draft: Draft;
};

export type PublishResult = {
  platform: PlatformId;
  success: boolean;
  url?: string;
  tweetIds?: string[];
  error?: string;
};

export type TwitterConfig = {
  clientId: string;
  clientSecret: string;
};

export type WechatConfig = {
  appId: string;
  appSecret: string;
  author?: string;
};

export type ContentPublishConfig = {
  twitter?: TwitterConfig;
  wechat?: WechatConfig;
  substack?: { publicationUrl?: string };
  defaultPlatform?: PlatformId;
};

export type TwitterToken = {
  access: string;
  refresh: string;
  expires: number;
};
