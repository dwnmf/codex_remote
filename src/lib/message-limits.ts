import type { Message } from "./types";

export const MAX_STREAM_MESSAGE_CHARS = 200_000;
export const MAX_THREAD_RENDER_MESSAGES = 400;
export const MAX_MARKDOWN_RENDER_CHARS = 12_000;

const TRUNCATED_SUFFIX = "\n\n[output truncated]";

function mergeStreamingChunk(current: string, chunk: string): string {
  if (!current) return chunk;
  if (!chunk) return current;

  // Some backends send full snapshots instead of pure deltas.
  if (chunk.startsWith(current)) return chunk;
  if (current.endsWith(chunk)) return current;

  const maxOverlap = Math.min(current.length, chunk.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (current.slice(-size) === chunk.slice(0, size)) {
      return current + chunk.slice(size);
    }
  }

  return current + chunk;
}

export function appendDeltaWithCap(
  current: string,
  delta: string,
  maxChars = MAX_STREAM_MESSAGE_CHARS,
): string {
  if (!delta) return current;
  const merged = mergeStreamingChunk(current, delta);
  if (merged.length <= maxChars) return merged;
  if (current.length >= maxChars) return current;

  const withHead = merged.slice(0, maxChars);
  if (withHead.endsWith(TRUNCATED_SUFFIX)) {
    return withHead;
  }
  return withHead + TRUNCATED_SUFFIX;
}

export function keepRecentMessages(messages: Message[], maxCount = MAX_THREAD_RENDER_MESSAGES): Message[] {
  if (messages.length <= maxCount) return messages;
  return messages.slice(messages.length - maxCount);
}
