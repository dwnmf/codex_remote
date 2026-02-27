import { describe, expect, test } from "bun:test";
import { ReleaseCockpit } from "./release";
import type { ReleaseCommandResult, ReleaseCommandRunner } from "./release";

function repoRootForPlatform(): string {
  return process.platform === "win32" ? "C:\\repo" : "/repo";
}

function mkResult(partial: Partial<ReleaseCommandResult>): ReleaseCommandResult {
  return {
    ok: partial.ok ?? true,
    code: partial.code ?? (partial.ok === false ? 1 : 0),
    stdout: partial.stdout ?? "",
    stderr: partial.stderr ?? "",
    command: partial.command ?? [],
    cwd: partial.cwd ?? "",
    durationMs: partial.durationMs ?? 1,
  };
}

class PollingRunner implements ReleaseCommandRunner {
  private nowMs = 0;
  private readonly queues = new Map<string, ReleaseCommandResult[]>();

  queue(match: string, responses: ReleaseCommandResult[]): void {
    this.queues.set(match, responses);
  }

  async run(command: string[], cwd: string): Promise<ReleaseCommandResult> {
    const joined = command.join(" ");
    const key = [...this.queues.keys()].find((entry) => joined.includes(entry));
    if (!key) {
      return mkResult({ ok: false, stderr: `No scripted response for ${joined}`, command, cwd });
    }
    const queue = this.queues.get(key)!;
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { ...next, command, cwd };
  }

  async sleep(ms: number): Promise<void> {
    this.nowMs += ms;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  now(): number {
    return this.nowMs;
  }
}

describe("release status polling", () => {
  test("status progresses from queued/running to succeeded with polling", async () => {
    const repoRoot = repoRootForPlatform();
    const runner = new PollingRunner();

    runner.queue("rev-parse --show-toplevel", [mkResult({ stdout: repoRoot })]);
    runner.queue("rev-parse HEAD", [mkResult({ stdout: "abc123" })]);
    runner.queue("symbolic-ref --quiet --short HEAD", [mkResult({ stdout: "main" })]);
    runner.queue("push --set-upstream", [mkResult({ stdout: "branch pushed" })]);
    runner.queue(" tag ", [mkResult({ stdout: "tagged" })]);
    runner.queue(" push origin v", [mkResult({ stdout: "tag pushed" })]);
    runner.queue("gh run list", [
      mkResult({
        stdout: JSON.stringify([]),
      }),
      mkResult({
        stdout: JSON.stringify([
          {
            databaseId: 55,
            status: "in_progress",
            conclusion: null,
            headSha: "abc123",
            workflowName: "release",
            createdAt: "2026-02-27T12:00:00Z",
            displayTitle: "Release v1.2.3",
          },
        ]),
      }),
      mkResult({
        stdout: JSON.stringify([
          {
            databaseId: 55,
            status: "completed",
            conclusion: "success",
            headSha: "abc123",
            workflowName: "release",
            createdAt: "2026-02-27T12:00:00Z",
            displayTitle: "Release v1.2.3",
          },
        ]),
      }),
    ]);
    runner.queue("gh release view", [
      mkResult({ ok: false, stderr: "release not found" }),
      mkResult({
        stdout: JSON.stringify({
          tagName: "v1.2.3",
          isDraft: true,
          publishedAt: null,
          url: "https://example/release/v1.2.3",
          assets: [],
        }),
      }),
      mkResult({
        stdout: JSON.stringify({
          tagName: "v1.2.3",
          isDraft: false,
          publishedAt: "2026-02-27T12:05:00Z",
          url: "https://example/release/v1.2.3",
          assets: [{ name: "artifact.tgz" }, { name: "checksums.txt" }],
        }),
      }),
    ]);

    const cockpit = new ReleaseCockpit({ runner });
    const started = (await cockpit.start({
      repoRoot,
      tag: "v1.2.3",
      workflow: "release.yml",
      requiredAssets: ["artifact.tgz", "checksums.txt"],
      pollIntervalMs: 250,
      timeoutMs: 8_000,
    })) as { jobId: string };

    const observedStates: string[] = [];
    let terminalState = "";
    for (let i = 0; i < 30; i += 1) {
      const status = cockpit.status({ jobId: started.jobId }) as {
        found: boolean;
        job?: { state: string; steps: Array<{ id: string; state: string }> };
      };
      expect(status.found).toBe(true);
      const state = status.job?.state ?? "unknown";
      observedStates.push(state);
      if (state === "succeeded" || state === "failed") {
        terminalState = state;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(observedStates.some((state) => state === "running")).toBe(true);
    expect(terminalState).toBe("succeeded");
    const final = cockpit.status({ jobId: started.jobId }) as {
      found: boolean;
      job?: { steps: Array<{ id: string; state: string }> };
    };
    expect(final.job?.steps.find((step) => step.id === "watch_workflow")?.state).toBe("succeeded");
    expect(final.job?.steps.find((step) => step.id === "confirm_release")?.state).toBe("succeeded");
  });
});
