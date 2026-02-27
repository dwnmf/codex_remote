import { afterEach, describe, expect, mock, test } from "bun:test";
import { extractMultiDispatchPayloads, normalizeArtifactsListResult } from "./artifacts";

const STORE_KEY = "__codex_remote_artifacts_store__";

function resetArtifactsSingleton() {
  delete (globalThis as Record<string, unknown>)[STORE_KEY];
}

afterEach(() => {
  mock.restore();
  resetArtifactsSingleton();
  delete (globalThis as Record<string, unknown>).$state;
});

describe("artifact parsers", () => {
  test("normalizes list payloads and sorts by newest first", () => {
    const result = normalizeArtifactsListResult(
      {
        data: [
          {
            id: "a-old",
            threadId: "thread-1",
            type: "bundle",
            title: "Old artifact",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "a-new",
            threadId: "thread-1",
            type: "report",
            title: "New artifact",
            createdAt: "2026-01-01T02:00:00.000Z",
          },
        ],
      },
      "thread-1",
    );

    expect(result.artifacts.map((item) => item.id)).toEqual(["a-new", "a-old"]);
  });

  test("accepts numeric artifact ids from backend payloads", () => {
    const result = normalizeArtifactsListResult(
      {
        artifacts: [
          {
            id: 42,
            threadId: "thread-1",
            artifactType: "command",
            summary: "pwsh command",
            createdAt: 1740787200000,
          },
        ],
      },
      "thread-1",
    );

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].id).toBe("42");
    expect(result.artifacts[0].threadId).toBe("thread-1");
  });

  test("extracts file paths from command payload metadata", () => {
    const result = normalizeArtifactsListResult(
      {
        artifacts: [
          {
            id: 99,
            threadId: "thread-2",
            itemType: "commandExecution",
            summary: "\"pwsh\" -Command \"Set-Content -Path artifact.txt -Value 'artifact'\"",
            payload: {
              type: "commandExecution",
              command: "\"pwsh\" -Command \"Set-Content -Path artifact.txt -Value 'artifact'\"",
            },
            createdAt: "2026-02-28T00:00:00.000Z",
          },
        ],
      },
      "thread-2",
    );

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe("commandExecution");
    expect(result.artifacts[0].metadata?.paths).toEqual(["artifact.txt"]);
  });

  test("extracts multi-dispatch entries", () => {
    const payloads = extractMultiDispatchPayloads({
      type: "orbit.multi-dispatch",
      dispatches: [
        {
          channel: "artifacts.timeline",
          threadId: "thread-1",
          event: "artifact.added",
          data: { id: "a-1" },
        },
      ],
    });

    expect(payloads).toEqual([
      {
        channel: "artifacts.timeline",
        threadId: "thread-1",
        event: "artifact.added",
        data: { id: "a-1" },
      },
    ]);
  });
});

describe("artifacts store", () => {
  test("loads artifacts and applies multi-dispatch updates", async () => {
    const protocolHandlers: Array<(msg: Record<string, unknown>) => void> = [];
    const socket = {
      artifactsList: mock(async () => ({
        artifacts: [
          {
            id: "artifact-1",
            threadId: "thread-1",
            type: "report",
            title: "Initial report",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      })),
      onProtocol(handler: (msg: Record<string, unknown>) => void) {
        protocolHandlers.push(handler);
        return () => {};
      },
    };

    Object.defineProperty(globalThis, "$state", {
      value: <T>(value: T) => value,
      configurable: true,
      writable: true,
    });
    mock.module("./socket.svelte", () => ({ socket }));
    resetArtifactsSingleton();

    const { artifacts } = await import("./artifacts.svelte.ts");

    await artifacts.requestThread("thread-1");
    expect(socket.artifactsList).toHaveBeenCalledWith("thread-1", undefined);
    expect(artifacts.getThreadArtifacts("thread-1").map((item) => item.id)).toEqual(["artifact-1"]);

    protocolHandlers[0]({
      type: "orbit.multi-dispatch",
      dispatches: [
        {
          channel: "artifacts.timeline",
          threadId: "thread-1",
          event: "artifact.added",
          data: {
            artifact: {
              id: "artifact-2",
              threadId: "thread-1",
              type: "bundle",
              title: "Build bundle",
              createdAt: "2026-01-01T01:00:00.000Z",
            },
          },
        },
      ],
    });

    expect(artifacts.getThreadArtifacts("thread-1").map((item) => item.id)).toEqual(["artifact-2", "artifact-1"]);

    protocolHandlers[0]({
      type: "orbit.multi-dispatch",
      dispatches: [
        {
          channel: "artifacts.timeline",
          threadId: "thread-1",
          event: "artifact.removed",
          data: {
            artifactId: "artifact-2",
          },
        },
      ],
    });

    expect(artifacts.getThreadArtifacts("thread-1").map((item) => item.id)).toEqual(["artifact-1"]);
  });
});
