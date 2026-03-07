import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Draft, DraftFile, PlatformId } from "./types.js";

const DRAFTS_REL_PATH = ["plugins", "content-publish", "drafts"] as const;

function resolveDraftsDir(stateDir: string): string {
  return path.join(stateDir, ...DRAFTS_REL_PATH);
}

function draftPath(stateDir: string, id: string): string {
  return path.join(resolveDraftsDir(stateDir), `${id}.json`);
}

function generateId(): string {
  return randomBytes(4).toString("hex");
}

export async function saveDraft(
  stateDir: string,
  params: { content: string; title?: string; platform?: PlatformId; id?: string },
): Promise<Draft> {
  const dir = resolveDraftsDir(stateDir);
  await fs.mkdir(dir, { recursive: true });

  const now = Date.now();
  const id = params.id ?? generateId();
  const filePath = draftPath(stateDir, id);

  let existing: Draft | null = null;
  if (params.id) {
    existing = await getDraft(stateDir, params.id);
  }

  const draft: Draft = {
    id,
    content: params.content,
    title: params.title ?? existing?.title,
    platform: params.platform ?? existing?.platform,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const file: DraftFile = { version: 1, draft };
  await fs.writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return draft;
}

export async function getDraft(stateDir: string, id: string): Promise<Draft | null> {
  try {
    const raw = await fs.readFile(draftPath(stateDir, id), "utf8");
    const parsed = JSON.parse(raw) as DraftFile;
    if (parsed.version !== 1 || !parsed.draft) return null;
    return parsed.draft;
  } catch {
    return null;
  }
}

export async function listDrafts(stateDir: string): Promise<Draft[]> {
  const dir = resolveDraftsDir(stateDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const drafts: Draft[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.replace(/\.json$/, "");
    const draft = await getDraft(stateDir, id);
    if (draft) drafts.push(draft);
  }

  // Most recent first
  drafts.sort((a, b) => b.updatedAt - a.updatedAt);
  return drafts;
}

export async function deleteDraft(stateDir: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(draftPath(stateDir, id));
    return true;
  } catch {
    return false;
  }
}
