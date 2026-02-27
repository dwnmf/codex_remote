import { describe, expect, test } from "bun:test";

import {
  MAX_ARTIFACTS_PER_THREAD,
  MAX_RECENT_MESSAGES,
  appendRecentMessage,
  buildMultiDispatchAggregate,
  buildThreadStateMutationFromMessage,
  createEmptyThreadState,
  normalizeStoredThreadState,
  parseMultiDispatchRequest,
  upsertArtifact,
} from "./orbit-relay-state";

describe("orbit relay state helpers", () => {
  test("appendRecentMessage enforces message retention and drops oversized payloads", () => {
    let messages: string[] = [];
    for (let i = 0; i < MAX_RECENT_MESSAGES + 5; i += 1) {
      messages = appendRecentMessage(messages, `msg-${i}`);
    }

    expect(messages.length).toBe(MAX_RECENT_MESSAGES);
    expect(messages[0]).toBe("msg-5");

    const oversized = "x".repeat(20_000);
    const afterOversized = appendRecentMessage(messages, oversized);
    expect(afterOversized).toEqual(messages);
  });

  test("buildThreadStateMutationFromMessage captures turn and artifact from completed item", () => {
    const raw = JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "Completed" },
        item: { id: "item-1", type: "commandExecution", aggregatedOutput: "ok" },
      },
    });

    const mutation = buildThreadStateMutationFromMessage(JSON.parse(raw), raw);
    expect(mutation?.threadId).toBe("thread-1");
    expect(mutation?.turnId).toBe("turn-1");
    expect(mutation?.turnStatus).toBe("Completed");
    expect(mutation?.artifact?.itemId).toBe("item-1");
    expect(mutation?.recentMessage).toBe(raw);
  });

  test("parseMultiDispatchRequest reads child rpc and target anchors", () => {
    const parsed = parseMultiDispatchRequest({
      type: "orbit.multi-dispatch",
      id: "req-1",
      anchorIds: ["a-1", "a-2", "a-1"],
      request: {
        method: "anchor.echo",
        params: { threadId: "thread-1", text: "hi" },
      },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.requestId).toBe("req-1");
    expect(parsed?.threadId).toBe("thread-1");
    expect(parsed?.anchorIds).toEqual(["a-1", "a-2"]);
    expect(parsed?.childRequest.method).toBe("anchor.echo");
  });

  test("buildMultiDispatchAggregate summarizes success/failure/timeout", () => {
    const aggregate = buildMultiDispatchAggregate("req-2", "thread-2", [
      { anchorId: "a-1", childId: "c-1", ok: true, result: { ok: true } },
      {
        anchorId: "a-2",
        childId: "c-2",
        ok: false,
        error: { code: -32001, message: "timeout", data: { code: "timeout" } },
      },
      { anchorId: "a-3", childId: "c-3", ok: false, error: { code: -32001, message: "failed" } },
    ]);

    expect(aggregate.summary.total).toBe(3);
    expect(aggregate.summary.ok).toBe(1);
    expect(aggregate.summary.failed).toBe(2);
    expect(aggregate.summary.timedOut).toBe(1);
  });

  test("normalizeStoredThreadState clamps artifacts/messages", () => {
    const artifacts = Array.from({ length: MAX_ARTIFACTS_PER_THREAD + 2 }).map((_, index) => ({
      id: `thread-1:item-${index}`,
      itemId: `item-${index}`,
      threadId: "thread-1",
      type: "commandExecution",
      createdAt: new Date().toISOString(),
      payload: { value: index },
    }));
    const messages = Array.from({ length: MAX_RECENT_MESSAGES + 3 }).map((_, index) => `message-${index}`);

    const normalized = normalizeStoredThreadState({
      threadId: "thread-1",
      anchorId: "anchor-1",
      turn: { id: "turn-1", status: "InProgress", updatedAt: new Date().toISOString() },
      recentMessages: messages,
      artifacts,
      updatedAt: new Date().toISOString(),
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.recentMessages.length).toBe(MAX_RECENT_MESSAGES);
    expect(normalized?.artifacts.length).toBe(MAX_ARTIFACTS_PER_THREAD);
  });

  test("upsertArtifact deduplicates by id and retains newest", () => {
    const base = createEmptyThreadState("thread-1");
    const afterOne = upsertArtifact(base.artifacts, {
      id: "thread-1:item-1",
      itemId: "item-1",
      threadId: "thread-1",
      type: "fileChange",
      createdAt: new Date().toISOString(),
      payload: { a: 1 },
    });

    const afterTwo = upsertArtifact(afterOne, {
      id: "thread-1:item-1",
      itemId: "item-1",
      threadId: "thread-1",
      type: "fileChange",
      createdAt: new Date().toISOString(),
      payload: { a: 2 },
    });

    expect(afterTwo.length).toBe(1);
    expect(afterTwo[0]?.payload).toEqual({ a: 2 });
  });
});
