import { describe, expect, test } from "bun:test";
import {
  buildReleaseCommandPlan,
  canTransitionJobState,
  createDefaultReleaseCommandRunner,
  parseReleaseView,
  parseWorkflowRuns,
} from "./release";
import { ReleaseCockpit } from "./release";
import type { ReleaseCommandResult, ReleaseCommandRunner } from "./release";

function repoRootForPlatform(): string {
  return process.platform === "win32" ? "C:\\repo" : "/repo";
}

function ok(command: string[], cwd: string, stdout = ""): ReleaseCommandResult {
  return { ok: true, code: 0, stdout, stderr: "", command, cwd, durationMs: 1 };
}

function fail(command: string[], cwd: string, stderr: string): ReleaseCommandResult {
  return { ok: false, code: 1, stdout: "", stderr, command, cwd, durationMs: 1 };
}

class ScriptedRunner implements ReleaseCommandRunner {
  private nowMs = 0;
  private readonly queues = new Map<string, ReleaseCommandResult[]>();

  queue(match: string, responses: ReleaseCommandResult[]): void {
    this.queues.set(match, responses);
  }

  async run(command: string[], cwd: string): Promise<ReleaseCommandResult> {
    const key = [...this.queues.keys()].find((entry) => command.join(" ").includes(entry));
    if (!key) {
      return fail(command, cwd, `No scripted response for ${command.join(" ")}`);
    }
    const queue = this.queues.get(key)!;
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { ...next, command, cwd };
  }

  async sleep(ms: number): Promise<void> {
    this.nowMs += ms;
  }

  now(): number {
    return this.nowMs;
  }
}

describe("release planning/parsing/state", () => {
  test("buildReleaseCommandPlan composes CI+git commands", () => {
    const repoRoot = repoRootForPlatform();
    const plan = buildReleaseCommandPlan({
      repoRoot,
      branch: "main",
      tag: "v1.2.3",
      remote: "origin",
      runCiLocal: true,
      ciCommand: "bun run ci:local",
      platform: "linux",
    });

    expect(plan.map((entry) => entry.stepId)).toEqual(["ci_local", "push_branch", "create_tag", "push_tag"]);
    expect(plan[0]?.command).toEqual(["bash", "-lc", "bun run ci:local"]);
    expect(plan[1]?.command).toEqual(["git", "-C", repoRoot, "push", "--set-upstream", "origin", "main"]);
  });

  test("parseWorkflowRuns parses gh run list JSON", () => {
    const runs = parseWorkflowRuns(
      JSON.stringify([
        {
          databaseId: 42,
          status: "completed",
          conclusion: "success",
          headSha: "abc",
          workflowName: "Release",
          createdAt: "2026-02-27T10:00:00Z",
          url: "https://example",
        },
      ]),
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]?.databaseId).toBe(42);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.conclusion).toBe("success");
  });

  test("parseReleaseView parses assets", () => {
    const release = parseReleaseView(
      JSON.stringify({
        tagName: "v1.2.3",
        isDraft: false,
        publishedAt: "2026-02-27T10:10:00Z",
        url: "https://example/release",
        assets: [{ name: "checksums.txt" }, { name: "binary.tgz" }],
      }),
    );
    expect(release.tagName).toBe("v1.2.3");
    expect(release.assets.map((asset) => asset.name)).toEqual(["checksums.txt", "binary.tgz"]);
  });

  test("canTransitionJobState enforces terminal states", () => {
    expect(canTransitionJobState("queued", "running")).toBe(true);
    expect(canTransitionJobState("running", "succeeded")).toBe(true);
    expect(canTransitionJobState("succeeded", "running")).toBe(false);
    expect(canTransitionJobState("failed", "queued")).toBe(false);
  });

  test("job transitions to failed when command step fails", async () => {
    const repoRoot = repoRootForPlatform();
    const runner = new ScriptedRunner();
    runner.queue("rev-parse --show-toplevel", [ok(["git"], repoRoot, repoRoot)]);
    runner.queue("rev-parse HEAD", [ok(["git"], repoRoot, "abc123")]);
    runner.queue("symbolic-ref --quiet --short HEAD", [ok(["git"], repoRoot, "main")]);
    runner.queue("push --set-upstream", [ok(["git"], repoRoot, "pushed")]);
    runner.queue(" tag ", [fail(["git"], repoRoot, "tag already exists")]);

    const cockpit = new ReleaseCockpit({ runner });
    const started = (await cockpit.start({
      repoRoot,
      tag: "v1.2.3",
      waitForWorkflow: false,
      waitForRelease: false,
    })) as { jobId: string };

    const completed = await cockpit.waitForJob(started.jobId);
    expect(completed).not.toBeNull();
    expect(completed?.state).toBe("failed");
    expect(completed?.steps.find((step) => step.id === "create_tag")?.state).toBe("failed");
  });

  test("default runner factory returns a runnable object", () => {
    const runner = createDefaultReleaseCommandRunner();
    expect(typeof runner.run).toBe("function");
    expect(typeof runner.sleep).toBe("function");
    expect(typeof runner.now).toBe("function");
  });
});
