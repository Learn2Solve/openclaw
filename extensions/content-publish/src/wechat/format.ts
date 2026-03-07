import { escapeHtml } from "../format-utils.js";

/**
 * Format content as inline-styled HTML for WeChat's mp.weixin.qq.com editor.
 * WeChat strips external CSS, so all styles must be inline.
 */
export function formatWechat(content: string, title?: string): string {
  const parts: string[] = [];

  if (title) {
    parts.push(
      `<h1 style="font-size:22px;font-weight:bold;color:#333;margin-bottom:16px;">${escapeHtml(title)}</h1>`,
    );
  }

  const paragraphs = content.split(/\n{2,}/);
  for (const para of paragraphs) {
    let html = escapeHtml(para.trim());
    if (!html) continue;

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:bold;">$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em style="font-style:italic;">$1</em>');
    // Links
    html = html.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a style="color:#576b95;text-decoration:none;" href="$2">$1</a>',
    );

    parts.push(
      `<p style="font-size:16px;color:#333;line-height:1.8;margin-bottom:16px;">${html}</p>`,
    );
  }

  return parts.join("\n");
}
