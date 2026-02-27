#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(process.cwd());
const backendPort = Number(process.env.LOCAL_BACKEND_PORT ?? 8080);
const frontendPort = Number(process.env.LOCAL_FRONTEND_PORT ?? 5173);

const baseEnv = {
  ...process.env,
  AUTH_URL: process.env.AUTH_URL ?? `http://localhost:${backendPort}`,
  DEVICE_VERIFICATION_URL: process.env.DEVICE_VERIFICATION_URL ?? `http://localhost:${frontendPort}/device`,
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? `http://localhost:${frontendPort}`,
  ANCHOR_ORBIT_URL: process.env.ANCHOR_ORBIT_URL ?? `ws://localhost:${backendPort}/ws/anchor`,
  AUTH_MODE: process.env.AUTH_MODE ?? "basic",
};

type ProcSpec = {
  name: string;
  cwd: string;
  cmd: string[];
  env?: Record<string, string | undefined>;
};

function resolveBackendCmd(): string[] {
  const candidates =
    process.platform === "win32"
      ? [
          ["py", "-3"],
          ["python"],
          ["python3"],
        ]
      : [
          ["python3"],
          ["python"],
        ];

  for (const candidate of candidates) {
    const executable = candidate[0];
    if (!Bun.which(executable)) continue;
    return [
      ...candidate,
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      "0.0.0.0",
      "--port",
      String(backendPort),
    ];
  }

  const tried = candidates.map((c) => c[0]).join(", ");
  console.error(`[dev:all] no Python launcher found in PATH (tried: ${tried})`);
  process.exit(1);
}

const backendCmd = resolveBackendCmd();

const specs: ProcSpec[] = [
  {
    name: "backend",
    cwd: resolve(rootDir, "services/control-plane"),
    cmd: backendCmd,
  },
  {
    name: "frontend",
    cwd: rootDir,
    cmd: ["bun", "run", "dev", "--", "--host", "0.0.0.0", "--port", String(frontendPort)],
    env: {
      AUTH_URL: baseEnv.AUTH_URL,
      AUTH_MODE: baseEnv.AUTH_MODE,
    },
  },
  {
    name: "anchor",
    cwd: rootDir,
    cmd: ["bun", "services/anchor/src/index.ts"],
    env: {
      ANCHOR_ORBIT_URL: baseEnv.ANCHOR_ORBIT_URL,
      AUTH_URL: baseEnv.AUTH_URL,
      ANCHOR_PORT: baseEnv.ANCHOR_PORT ?? "8788",
      ANCHOR_JWT_TTL_SEC: baseEnv.ANCHOR_JWT_TTL_SEC ?? "300",
      ANCHOR_APP_CWD: baseEnv.ANCHOR_APP_CWD,
      CODEX_REMOTE_CREDENTIALS_FILE: baseEnv.CODEX_REMOTE_CREDENTIALS_FILE,
    },
  },
];

if (!existsSync(resolve(rootDir, ".env"))) {
  console.warn("[dev:all] .env not found; defaults will be used where possible.");
}

function streamLines(
  stream: ReadableStream<Uint8Array> | null | undefined | number,
  name: string,
  isError: boolean
): void {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const prefix = `[${name}]`;

  void (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (line.length === 0) continue;
        if (isError) console.error(`${prefix} ${line}`);
        else console.log(`${prefix} ${line}`);
      }
    }
    const tail = buffer.trim();
    if (tail) {
      if (isError) console.error(`${prefix} ${tail}`);
      else console.log(`${prefix} ${tail}`);
    }
  })();
}

const processes: Array<{ name: string; proc: Bun.Subprocess }> = [];
let shuttingDown = false;

function shutdownAll(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev:all] stopping (${reason})...`);
  for (const { proc } of processes) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    for (const { proc } of processes) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    process.exit(0);
  }, 1500);
}

process.on("SIGINT", () => shutdownAll("SIGINT"));
process.on("SIGTERM", () => shutdownAll("SIGTERM"));

async function waitForBackend(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return true;
    } catch {
      // ignore and retry
    }
    await Bun.sleep(500);
  }
  return false;
}

function startProcess(spec: ProcSpec): void {
  const proc = Bun.spawn({
    cmd: spec.cmd,
    cwd: spec.cwd,
    env: {
      ...baseEnv,
      ...(spec.env ?? {}),
    },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  processes.push({ name: spec.name, proc });
  streamLines(proc.stdout, spec.name, false);
  streamLines(proc.stderr, spec.name, true);

  proc.exited.then((code) => {
    if (shuttingDown) return;
    console.error(`[dev:all] process "${spec.name}" exited with code ${code}`);
    shutdownAll(`${spec.name} exited`);
  });
}

console.log("[dev:all] starting local stack:");
console.log(`  backend:  http://localhost:${backendPort}`);
console.log(`  frontend: http://localhost:${frontendPort}`);
console.log(`  anchor ws target: ${baseEnv.ANCHOR_ORBIT_URL}`);
console.log("  stop: Ctrl+C");

const backendSpec = specs.find((s) => s.name === "backend");
const frontendSpec = specs.find((s) => s.name === "frontend");
const anchorSpec = specs.find((s) => s.name === "anchor");

if (!backendSpec || !frontendSpec || !anchorSpec) {
  console.error("[dev:all] internal error: missing process spec");
  process.exit(1);
}

startProcess(backendSpec);
startProcess(frontendSpec);

const backendReady = await waitForBackend(`http://localhost:${backendPort}/health`, 20000);
if (!backendReady) {
  console.error("[dev:all] backend health check failed; anchor may not authenticate.");
}

startProcess(anchorSpec);
