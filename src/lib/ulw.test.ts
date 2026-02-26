import { describe, expect, test } from "bun:test";
import type { Message } from "./types";
import {
  ULW_DEFAULT_COMPLETION_PROMISE,
  ULW_DEFAULT_MAX_ITERATIONS,
  UlwRuntime,
  buildUlwContinuationPrompt,
  buildUlwKickoffPrompt,
  hasCompletionPromise,
  parseUlwCommand,
  pickUlwTaskFromMessages,
} from "./ulw";

describe("parseUlwCommand", () => {
  test("parses start command for /u", () => {
    const parsed = parseUlwCommand("/u fix auth flow");
    expect(parsed).toEqual({
      kind: "start",
      task: "fix auth flow",
    });
  });

  test("parses stop command", () => {
    const parsed = parseUlwCommand("/ulw stop");
    expect(parsed).toEqual({ kind: "stop" });
  });

  test("parses config command", () => {
    const parsed = parseUlwCommand("/u config max=55 promise=FINISHED");
    expect(parsed).toEqual({
      kind: "config",
      maxIterations: 55,
      completionPromise: "FINISHED",
    });
  });

  test("parses legacy flags for start command", () => {
    const parsed = parseUlwCommand("/ulw \"ship release\" --max-iterations=40 --completion-promise=READY");
    expect(parsed).toEqual({
      kind: "start",
      task: "ship release",
      maxIterations: 40,
      completionPromise: "READY",
    });
  });
});

describe("hasCompletionPromise", () => {
  test("detects completion promise tag", () => {
    expect(hasCompletionPromise("done <promise>DONE</promise>", "DONE")).toBe(true);
  });

  test("ignores non-matching promise", () => {
    expect(hasCompletionPromise("<promise>NOT_DONE</promise>", "DONE")).toBe(false);
  });
});

describe("pickUlwTaskFromMessages", () => {
  test("uses latest non-command user message", () => {
    const history: Message[] = [
      { id: "1", role: "user", text: "first idea", threadId: "t" },
      { id: "2", role: "assistant", text: "ok", threadId: "t" },
      { id: "3", role: "user", text: "/u stop", threadId: "t" },
      { id: "4", role: "user", text: "final task", threadId: "t" },
    ];
    expect(pickUlwTaskFromMessages(history)).toBe("final task");
  });
});

describe("UlwRuntime", () => {
  test("starts with defaults and advances iterations", () => {
    const runtime = new UlwRuntime();
    const state = runtime.start("thread-1", { task: "finish integration" });
    expect(state.completionPromise).toBe(ULW_DEFAULT_COMPLETION_PROMISE);
    expect(state.maxIterations).toBe(ULW_DEFAULT_MAX_ITERATIONS);
    expect(state.iteration).toBe(1);

    const advanced = runtime.advance("thread-1");
    expect(advanced?.iteration).toBe(2);
  });

  test("configures defaults and uses them on next start", () => {
    const runtime = new UlwRuntime();
    runtime.configure("thread-2", { maxIterations: 7, completionPromise: "OK" });
    const state = runtime.start("thread-2", { task: "task" });
    expect(state.maxIterations).toBe(7);
    expect(state.completionPromise).toBe("OK");
  });
});

describe("prompt builders", () => {
  test("includes promise tag in prompts", () => {
    const runtime = new UlwRuntime();
    const state = runtime.start("thread-3", { task: "build feature", completionPromise: "DONE" });
    const kickoff = buildUlwKickoffPrompt(state);
    const continuation = buildUlwContinuationPrompt(state);
    expect(kickoff.includes("<promise>DONE</promise>")).toBe(true);
    expect(continuation.includes("<promise>DONE</promise>")).toBe(true);
  });
});
