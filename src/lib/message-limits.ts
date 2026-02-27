import type { Message } from "./types";

export const MAX_STREAM_MESSAGE_CHARS = 200_000;
export const MAX_THREAD_RENDER_MESSAGES = 400;
export const MAX_MARKDOWN_RENDER_CHARS = 12_000;

const TRUNCATED_SUFFIX = "\n\n[output truncated]";

export function appendDeltaWithCap(
  current: string,
  delta: string,
  maxChars = MAX_STREAM_MESSAGE_CHARS,
): string {
  if (!delta) return current;
  if (current.length >= maxChars) return current;

  const remaining = maxChars - current.length;
  if (delta.length <= remaining) {
    return current + delta;
  }

  const head = delta.slice(0, remaining);
  const withHead = current + head;
  if (withHead.endsWith(TRUNCATED_SUFFIX)) {
    return withHead;
  }
  return withHead + TRUNCATED_SUFFIX;
}

export function keepRecentMessages(messages: Message[], maxCount = MAX_THREAD_RENDER_MESSAGES): Message[] {
  if (messages.length <= maxCount) return messages;
  return messages.slice(messages.length - maxCount);
}

