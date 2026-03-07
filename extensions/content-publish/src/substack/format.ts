import { markdownToHtml } from "../format-utils.js";

/**
 * Format content as clean semantic HTML for pasting into Substack's editor.
 * Substack accepts standard HTML - no inline styles needed.
 */
export function formatSubstack(content: string, title?: string): string {
  const parts: string[] = [];

  if (title) {
    parts.push(`<h1>${title}</h1>`);
  }

  parts.push(markdownToHtml(content));

  return parts.join("\n\n");
}
