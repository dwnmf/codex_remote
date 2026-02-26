import type { Message } from "./types";

export const ULW_DEFAULT_COMPLETION_PROMISE = "DONE";
export const ULW_DEFAULT_MAX_ITERATIONS = 30;

const ULW_MIN_ITERATIONS = 1;
const ULW_MAX_ITERATIONS = 200;

export interface UlwDefaults {
  completionPromise: string;
  maxIterations: number;
}

export interface UlwState extends UlwDefaults {
  active: boolean;
  task: string;
  iteration: number;
  startedAt: number;
  stopReason?: string;
}

export type UlwCommand =
  | {
      kind: "start";
      task: string | null;
      completionPromise?: string;
      maxIterations?: number;
    }
  | {
      kind: "stop";
    }
  | {
      kind: "config";
      completionPromise?: string;
      maxIterations?: number;
    };

interface StartOptions {
  task: string;
  completionPromise?: string;
  maxIterations?: number;
}

function clampIterations(value: number): number {
  return Math.max(ULW_MIN_ITERATIONS, Math.min(ULW_MAX_ITERATIONS, value));
}

function parseIterations(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return clampIterations(parsed);
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizePromise(raw: string | undefined): string | undefined {
  const next = stripWrappingQuotes(raw ?? "");
  return next || undefined;
}

function parseStartOptions(raw: string): {
  task: string | null;
  completionPromise?: string;
  maxIterations?: number;
} {
  let taskPart = raw;
  let completionPromise: string | undefined;
  let maxIterations: number | undefined;

  const maxMatch = taskPart.match(/(?:^|\s)--(?:max-iterations|max)\s*=\s*(\d+)(?=\s|$)/i);
  if (maxMatch) {
    maxIterations = parseIterations(maxMatch[1]);
    taskPart = taskPart.replace(maxMatch[0], " ").trim();
  }

  const promiseMatch = taskPart.match(/(?:^|\s)--(?:completion-promise|promise)\s*=\s*("[^"]+"|'[^']+'|\S+)(?=\s|$)/i);
  if (promiseMatch) {
    completionPromise = normalizePromise(promiseMatch[1]);
    taskPart = taskPart.replace(promiseMatch[0], " ").trim();
  }

  const task = stripWrappingQuotes(taskPart);
  return {
    task: task || null,
    ...(completionPromise ? { completionPromise } : {}),
    ...(typeof maxIterations === "number" ? { maxIterations } : {}),
  };
}

function parseConfigOptions(raw: string): { completionPromise?: string; maxIterations?: number } {
  let completionPromise: string | undefined;
  let maxIterations: number | undefined;
  const tokenPattern = /(\w+)\s*=\s*("[^"]+"|'[^']+'|\S+)/g;
  let match: RegExpExecArray | null = null;

  while ((match = tokenPattern.exec(raw)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === "max") {
      maxIterations = parseIterations(value);
      continue;
    }
    if (key === "promise") {
      completionPromise = normalizePromise(value);
    }
  }

  return {
    ...(typeof maxIterations === "number" ? { maxIterations } : {}),
    ...(completionPromise ? { completionPromise } : {}),
  };
}

export function parseUlwCommand(input: string): UlwCommand | null {
  const trimmed = input.trim();
  const prefixMatch = /^\/(u|ulw)\b/i.exec(trimmed);
  if (!prefixMatch) return null;

  const rest = trimmed.slice(prefixMatch[0].length).trim();
  if (!rest) {
    return { kind: "start", task: null };
  }

  if (/^stop$/i.test(rest)) {
    return { kind: "stop" };
  }

  if (/^config\b/i.test(rest)) {
    const options = parseConfigOptions(rest.slice("config".length).trim());
    return { kind: "config", ...options };
  }

  return { kind: "start", ...parseStartOptions(rest) };
}

export function hasCompletionPromise(text: string, completionPromise: string): boolean {
  const promise = completionPromise.trim();
  if (!promise) return false;
  const escaped = promise.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<promise>\\s*${escaped}\\s*<\\/promise>`, "i");
  return pattern.test(text);
}

export function pickUlwTaskFromMessages(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = message.text.trim();
    if (!text) continue;
    if (parseUlwCommand(text)) continue;
    return text;
  }
  return null;
}

export function buildUlwKickoffPrompt(state: UlwState): string {
  return [
    "ULTRAWORK LOOP MODE",
    `Task: ${state.task}`,
    `Turn budget: ${state.maxIterations}`,
    "Work continuously until the task is fully complete.",
    `When fully complete, include exactly <promise>${state.completionPromise}</promise> in your final response.`,
    "If not complete yet, continue with concrete progress and the next action.",
    "Start now.",
  ].join("\n");
}

export function buildUlwContinuationPrompt(state: UlwState): string {
  return [
    `ULTRAWORK LOOP CONTINUE (${state.iteration}/${state.maxIterations})`,
    `Continue the same task: ${state.task}`,
    "Do not stop early.",
    `Only when fully complete, include exactly <promise>${state.completionPromise}</promise>.`,
  ].join("\n");
}

export class UlwRuntime {
  #stateByThread = new Map<string, UlwState>();
  #defaultsByThread = new Map<string, UlwDefaults>();

  getDefaults(threadId: string): UlwDefaults {
    return this.#defaultsByThread.get(threadId) ?? {
      completionPromise: ULW_DEFAULT_COMPLETION_PROMISE,
      maxIterations: ULW_DEFAULT_MAX_ITERATIONS,
    };
  }

  configure(threadId: string, update: { completionPromise?: string; maxIterations?: number }): UlwDefaults {
    const current = this.getDefaults(threadId);
    const next: UlwDefaults = {
      completionPromise: normalizePromise(update.completionPromise) ?? current.completionPromise,
      maxIterations:
        typeof update.maxIterations === "number" ? clampIterations(update.maxIterations) : current.maxIterations,
    };
    this.#defaultsByThread.set(threadId, next);
    return next;
  }

  start(threadId: string, options: StartOptions): UlwState {
    const defaults = this.getDefaults(threadId);
    const state: UlwState = {
      active: true,
      task: options.task.trim(),
      completionPromise: normalizePromise(options.completionPromise) ?? defaults.completionPromise,
      maxIterations: clampIterations(options.maxIterations ?? defaults.maxIterations),
      iteration: 1,
      startedAt: Date.now(),
    };
    this.#stateByThread.set(threadId, state);
    return state;
  }

  get(threadId: string): UlwState | null {
    return this.#stateByThread.get(threadId) ?? null;
  }

  isActive(threadId: string): boolean {
    return Boolean(this.#stateByThread.get(threadId)?.active);
  }

  stop(threadId: string, stopReason?: string): UlwState | null {
    const state = this.#stateByThread.get(threadId);
    if (!state) return null;
    state.active = false;
    if (stopReason) state.stopReason = stopReason;
    this.#stateByThread.set(threadId, state);
    return state;
  }

  advance(threadId: string): UlwState | null {
    const state = this.#stateByThread.get(threadId);
    if (!state || !state.active) return null;
    state.iteration += 1;
    this.#stateByThread.set(threadId, state);
    return state;
  }

  clear(threadId: string): void {
    this.#stateByThread.delete(threadId);
  }
}

const STORE_KEY = "__zane_ulw_runtime__";

function getRuntime(): UlwRuntime {
  const global = globalThis as Record<string, unknown>;
  if (!global[STORE_KEY]) {
    global[STORE_KEY] = new UlwRuntime();
  }
  return global[STORE_KEY] as UlwRuntime;
}

export const ulwRuntime = getRuntime();
