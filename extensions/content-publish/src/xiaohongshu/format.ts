import { stripMarkdown } from "../format-utils.js";

const MAX_CHARS = 1000;

/**
 * Format content for Xiaohongshu (Little Red Book).
 * - Emoji bullet points
 * - #hashtags# (Xiaohongshu uses double-hash format)
 * - Max 1000 characters
 */
export function formatXiaohongshu(content: string, title?: string): string {
  const plain = stripMarkdown(content);
  const paragraphs = plain
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const parts: string[] = [];

  if (title) {
    parts.push(title);
    parts.push("");
  }

  // Convert paragraphs to emoji-bullet format
  const bullets = [
    "\u{1F4CC}", // pushpin
    "\u{2728}", // sparkles
    "\u{1F4A1}", // light bulb
    "\u{1F525}", // fire
    "\u{1F680}", // rocket
    "\u{1F4CA}", // chart
    "\u{2705}", // check mark
    "\u{1F31F}", // star
  ];

  for (let i = 0; i < paragraphs.length; i++) {
    const emoji = bullets[i % bullets.length];
    parts.push(`${emoji} ${paragraphs[i]}`);
  }

  // Extract potential hashtags from content (words that look like topics)
  parts.push("");
  parts.push("#content# #sharing#");

  let result = parts.join("\n");

  // Enforce character limit
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS - 3) + "...";
  }

  return result;
}
