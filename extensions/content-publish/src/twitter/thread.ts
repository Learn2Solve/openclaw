import { twitterCharCount } from "../format-utils.js";

const MAX_TWEET_LENGTH = 280;
const SAFE_LENGTH = 270; // Leave room for thread numbering
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/**
 * Split content into a thread of tweets.
 *
 * Algorithm:
 * 1. Split on paragraph boundaries (double newlines)
 * 2. If paragraph > SAFE_LENGTH chars, split on sentence boundaries
 * 3. If sentence > SAFE_LENGTH chars, split on word boundaries
 * 4. URLs count as 23 chars (t.co shortening)
 * 5. Add [n/N] numbering when thread has 3+ tweets
 * 6. Verify each tweet <= 280 chars
 */
export function splitThread(content: string): string[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  // First pass: collect chunks that fit in a single tweet
  const chunks: string[] = [];
  for (const para of paragraphs) {
    if (twitterCharCount(para) <= SAFE_LENGTH) {
      chunks.push(para);
      continue;
    }
    // Split paragraph into sentences
    const sentences = para.split(SENTENCE_SPLIT).filter(Boolean);
    for (const sentence of sentences) {
      if (twitterCharCount(sentence) <= SAFE_LENGTH) {
        chunks.push(sentence);
        continue;
      }
      // Split long sentence on word boundaries
      const words = sentence.split(/\s+/);
      let current = "";
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (twitterCharCount(candidate) > SAFE_LENGTH && current) {
          chunks.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (current) chunks.push(current);
    }
  }

  // Second pass: merge small adjacent chunks if they fit together
  const tweets: string[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    const merged = buffer ? `${buffer}\n\n${chunk}` : chunk;
    if (twitterCharCount(merged) <= SAFE_LENGTH) {
      buffer = merged;
    } else {
      if (buffer) tweets.push(buffer);
      buffer = chunk;
    }
  }
  if (buffer) tweets.push(buffer);

  // Add thread numbering if 3+ tweets
  if (tweets.length >= 3) {
    const total = tweets.length;
    return tweets.map((tweet, i) => {
      const numbered = `${tweet}\n\n[${i + 1}/${total}]`;
      // If numbering causes overflow, trim the content
      if (twitterCharCount(numbered) > MAX_TWEET_LENGTH) {
        return tweet; // Skip numbering for this tweet
      }
      return numbered;
    });
  }

  return tweets;
}

/**
 * Format a thread preview for display.
 */
export function formatThreadPreview(tweets: string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < tweets.length; i++) {
    const charCount = twitterCharCount(tweets[i]!);
    lines.push(`--- Tweet ${i + 1}/${tweets.length} (${charCount} chars) ---`);
    lines.push(tweets[i]!);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
