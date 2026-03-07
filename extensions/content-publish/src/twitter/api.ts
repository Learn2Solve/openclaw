const TWITTER_API_BASE = "https://api.x.com/2";

export type TweetResponse = {
  data: {
    id: string;
    text: string;
  };
};

/**
 * Post a single tweet.
 */
export async function postTweet(
  accessToken: string,
  text: string,
  replyToId?: string,
): Promise<TweetResponse> {
  const body: Record<string, unknown> = { text };
  if (replyToId) {
    body.reply = { in_reply_to_tweet_id: replyToId };
  }

  const res = await fetch(`${TWITTER_API_BASE}/tweets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twitter API error (${res.status}): ${errText || res.statusText}`);
  }

  return (await res.json()) as TweetResponse;
}

/**
 * Post a thread of tweets, chaining each as a reply to the previous.
 * Returns all tweet IDs in order.
 */
export async function postThread(
  accessToken: string,
  tweets: string[],
): Promise<{ tweetIds: string[]; firstTweetId: string }> {
  if (tweets.length === 0) {
    throw new Error("Cannot post empty thread.");
  }

  const tweetIds: string[] = [];
  let previousId: string | undefined;

  for (const text of tweets) {
    const response = await postTweet(accessToken, text, previousId);
    tweetIds.push(response.data.id);
    previousId = response.data.id;
  }

  return { tweetIds, firstTweetId: tweetIds[0]! };
}

/**
 * Get the authenticated user's username (for building tweet URLs).
 */
export async function getMe(accessToken: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${TWITTER_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twitter API error (${res.status}): ${errText || res.statusText}`);
  }

  const data = (await res.json()) as { data: { id: string; username: string } };
  return data.data;
}
