/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Simple markdown-to-HTML: handles **bold**, *italic*, [link](url), and paragraphs.
 */
export function markdownToHtml(md: string): string {
  let html = escapeHtml(md);
  // bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // links (already escaped, so unescape the quotes in href)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // paragraphs
  const paragraphs = html.split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${p.trim()}</p>`).join("\n");
}

/**
 * Strip markdown formatting, leaving plain text.
 */
export function stripMarkdown(md: string): string {
  let text = md;
  // links: [text](url) -> text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // bold/italic
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/\*(.+?)\*/g, "$1");
  return text;
}

/**
 * Count effective characters for Twitter, treating URLs as 23 chars (t.co).
 */
export function twitterCharCount(text: string): number {
  const TCO_LENGTH = 23;
  const urlPattern = /https?:\/\/\S+/g;
  let count = text.length;
  for (const match of text.matchAll(urlPattern)) {
    count += TCO_LENGTH - match[0].length;
  }
  return count;
}
