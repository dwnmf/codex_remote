import { afterEach, describe, expect, mock, test, vi } from "bun:test";
import {
  isReleaseTerminalStatus,
  normalizeReleaseInspectResult,
  normalizeReleaseStatusResult,
} from "./release-cockpit";

const STORE_KEY = "__codex_remote_release_cockpit_store__";

function resetReleaseCockpitSingleton() {
  delete (globalThis as Record<string, unknown>)[STORE_KEY];
}

afterEach(() => {
  vi.useRealTimers();
  mock.restore();
  resetReleaseCockpitSingleton();
  delete (globalThis as Record<string, unknown>).$state;
});

describe("release parser", () => {
  test("normalizes inspect payload with checks", () => {
    const result = normalizeReleaseInspectResult({
      ready: false,
      branch: "main",
      checks: [
        { id: "git-clean", label: "Git clean", status: "pass" },
        { id: "tests", label: "Tests", status: "fail", message: "2 tests failing" },
      ],
      warnings: ["Tag not provided"],
    });

    expect(result.ready).toBe(false);
    expect(result.branch).toBe("main");
    expect(result.checks.map((item) => item.status)).toEqual(["pass", "fail"]);
    expect(result.notes).toEqual(["Tag not provided"]);
  });

  test("normalizes release status logs/assets", () => {
    const result = normalizeReleaseStatusResult(
      {
        releaseId: "rel-1",
        status: "running",
        logs: [{ id: "l1", ts: "2026-01-01T00:00:00.000Z", level: "info", message: "building" }],
        assets: [{ id: "asset-1", name: "zip", path: "dist/app.zip" }],
      },
      "fallback",
    );

    expect(result.releaseId).toBe("rel-1");
    expect(result.logs).toHaveLength(1);
    expect(result.assets[0].path).toBe("dist/app.zip");
    expect(isReleaseTerminalStatus("completed")).toBe(true);
    expect(isReleaseTerminalStatus("running")).toBe(false);
  });
});

describe("release cockpit store", () => {
  test("handles inspect/start/poll transitions and protocol updates", async () => {
    vi.useFakeTimers();

    const protocolHandlers: Array<(msg: Record<string, unknown>) => void> = [];
    let statusCallCount = 0;
    const socket = {
      releaseInspect: mock(async () => ({
        ready: true,
        branch: "main",
        checks: [{ id: "checks", label: "Checks", status: "pass" }],
      })),
      releaseStart: mock(async () => ({
        releaseId: "release-1",
        status: "queued",
        message: "queued",
      })),
      releaseStatus: mock(async () => {
        statusCallCount += 1;
        if (statusCallCount === 1) {
          return {
            releaseId: "release-1",
            status: "running",
            logs: [{ id: "log-1", ts: "2026-01-01T00:00:00.000Z", level: "info", message: "build started" }],
          };
        }
        return {
          releaseId: "release-1",
          status: "completed",
          logs: [{ id: "log-2", ts: "2026-01-01T00:01:00.000Z", level: "info", message: "build done" }],
          assets: [{ id: "asset-1", label: "bundle.zip", path: "dist/bundle.zip" }],
          links: [{ id: "link-1", label: "Release page", href: "https://example.test/release/1" }],
        };
      }),
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
    resetReleaseCockpitSingleton();

    const { releaseCockpit } = await import("./release-cockpit.svelte.ts");

    await releaseCockpit.inspectRelease({ repoPath: "/repo" });
    expect(releaseCockpit.inspect?.ready).toBe(true);

    await releaseCockpit.startRelease({ repoPath: "/repo", tag: "v1.0.0" });
    expect(releaseCockpit.releaseId).toBe("release-1");
    expect(releaseCockpit.status?.status).toBe("running");
    expect(releaseCockpit.polling).toBe(true);

    protocolHandlers[0]({
      type: "orbit.multi-dispatch",
      dispatches: [
        {
          channel: "release.logs",
          releaseId: "release-1",
          data: {
            releaseId: "release-1",
            status: "running",
            logs: [{ id: "log-dispatch", ts: "2026-01-01T00:00:30.000Z", level: "info", message: "tests passed" }],
          },
        },
      ],
    });

    expect(releaseCockpit.status?.logs.some((entry) => entry.id === "log-dispatch")).toBe(true);

    await releaseCockpit.pollStatus();
    expect(releaseCockpit.status?.status).toBe("completed");
    expect(releaseCockpit.polling).toBe(false);
    expect(releaseCockpit.status?.assets[0]?.path).toBe("dist/bundle.zip");
  });
});
