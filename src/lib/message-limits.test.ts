import { describe, expect, test } from "bun:test";

import {
  MAX_STREAM_MESSAGE_CHARS,
  appendDeltaWithCap,
  keepRecentMessages,
} from "./message-limits";
import type { Message } from "./types";

describe("message limits", () => {
  test("appendDeltaWithCap truncates oversized streams and stays bounded", () => {
    const base = "a".repeat(MAX_STREAM_MESSAGE_CHARS - 2);
    const next = appendDeltaWithCap(base, "zzzz");
    expect(next.length).toBeGreaterThanOrEqual(MAX_STREAM_MESSAGE_CHARS);
    expect(next.startsWith(base)).toBe(true);

    const afterCap = appendDeltaWithCap(next, "more");
    expect(afterCap).toBe(next);
  });

  test("keepRecentMessages returns latest entries only", () => {
    const messages: Message[] = Array.from({ length: 6 }).map((_, index) => ({
      id: `m-${index}`,
      role: "assistant",
      text: `${index}`,
      threadId: "thread-1",
    }));

    const recent = keepRecentMessages(messages, 3);
    expect(recent.map((message) => message.id)).toEqual(["m-3", "m-4", "m-5"]);
  });
});

