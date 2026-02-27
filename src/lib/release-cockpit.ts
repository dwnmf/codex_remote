import type {
  ReleaseAsset,
  ReleaseCheck,
  ReleaseCheckStatus,
  ReleaseInspectResult,
  ReleaseLogEntry,
  ReleaseStartResult,
  ReleaseStatusResult,
} from "./types";

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return null;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && trimmed.length >= 10) {
      const millis = trimmed.length >= 13 ? asNumber : asNumber * 1_000;
      return new Date(millis).toISOString();
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toStringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeCheckStatus(value: unknown): ReleaseCheckStatus {
  const raw = toStringValue(value)?.toLowerCase() ?? "";
  if (raw.includes("pass") || raw.includes("ok") || raw.includes("ready")) return "pass";
  if (raw.includes("warn")) return "warn";
  if (raw.includes("fail") || raw.includes("error") || raw.includes("block")) return "fail";
  return "unknown";
}

function normalizeReleaseCheck(value: unknown, index: number): ReleaseCheck | null {
  if (typeof value === "string") {
    return {
      id: `check-${index + 1}`,
      label: value,
      status: "unknown",
    };
  }

  const record = toRecord(value);
  if (!record) return null;

  const label =
    toStringValue(record.label) ??
    toStringValue(record.name) ??
    toStringValue(record.title);
  if (!label) return null;

  return {
    id:
      toStringValue(record.id) ??
      toStringValue(record.key) ??
      `check-${index + 1}`,
    label,
    status: normalizeCheckStatus(record.status ?? record.level ?? record.result),
    detail: toStringValue(record.detail) ?? toStringValue(record.message) ?? undefined,
  };
}

function normalizeReleaseAsset(value: unknown, index: number): ReleaseAsset | null {
  if (typeof value === "string") {
    const href = toStringValue(value);
    if (!href) return null;
    return { id: `asset-${index + 1}-${href}`, label: href, href };
  }
  const record = toRecord(value);
  if (!record) return null;

  const href = toStringValue(record.href) ?? toStringValue(record.url) ?? toStringValue(record.link);
  const path = toStringValue(record.path) ?? toStringValue(record.file) ?? toStringValue(record.filePath);
  const label =
    toStringValue(record.label) ??
    toStringValue(record.name) ??
    toStringValue(record.title) ??
    href ??
    path;
  if (!label) return null;

  return {
    id:
      toStringValue(record.id) ??
      (href ? `asset-${href}` : null) ??
      (path ? `asset-${path}` : null) ??
      `asset-${index + 1}`,
    label,
    ...(href ? { href } : {}),
    ...(path ? { path } : {}),
    kind: toStringValue(record.kind) ?? toStringValue(record.type) ?? undefined,
  };
}

function normalizeReleaseLog(value: unknown, index: number): ReleaseLogEntry | null {
  if (typeof value === "string") {
    const message = toStringValue(value);
    if (!message) return null;
    const ts = new Date().toISOString();
    return {
      id: `log-${index + 1}-${message.slice(0, 24)}`,
      ts,
      level: "info",
      message,
    };
  }

  const record = toRecord(value);
  if (!record) return null;
  const message =
    toStringValue(record.message) ??
    toStringValue(record.text) ??
    toStringValue(record.line);
  if (!message) return null;

  const ts =
    toIsoDate(record.ts) ??
    toIsoDate(record.time) ??
    toIsoDate(record.timestamp) ??
    new Date().toISOString();
  const level =
    toStringValue(record.level) ??
    toStringValue(record.severity) ??
    toStringValue(record.type) ??
    "info";

  return {
    id:
      toStringValue(record.id) ??
      toStringValue(record.logId) ??
      `log-${index + 1}-${ts}`,
    ts,
    level,
    message,
  };
}

function normalizeReleaseLogs(record: Record<string, unknown>): ReleaseLogEntry[] {
  const raw: unknown[] = [];
  if (Array.isArray(record.logs)) raw.push(...record.logs);
  if (Array.isArray(record.entries)) raw.push(...record.entries);
  if (Array.isArray(record.events)) raw.push(...record.events);
  if (Array.isArray(record.history)) raw.push(...record.history);
  if (record.log) raw.push(record.log);

  const output = toStringValue(record.output) ?? toStringValue(record.stdout);
  if (output) {
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) raw.push(trimmed);
    }
  }

  if (toStringValue(record.message) && raw.length === 0) {
    raw.push(record);
  }

  const logs: ReleaseLogEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const normalized = normalizeReleaseLog(raw[i], i);
    if (!normalized) continue;
    if (logs.some((entry) => entry.id === normalized.id)) continue;
    logs.push(normalized);
  }

  logs.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return logs;
}

export function normalizeReleaseInspectResult(value: unknown): ReleaseInspectResult {
  const record = toRecord(value) ?? {};
  const rawChecks = Array.isArray(record.checks)
    ? record.checks
    : Array.isArray(record.validation)
      ? record.validation
      : Array.isArray(record.readiness)
        ? record.readiness
        : [];

  const checks: ReleaseCheck[] = [];
  for (let i = 0; i < rawChecks.length; i += 1) {
    const check = normalizeReleaseCheck(rawChecks[i], i);
    if (check) checks.push(check);
  }

  const explicitReady =
    toBooleanValue(record.ready) ??
    toBooleanValue(record.releaseReady) ??
    toBooleanValue(record.canRelease);
  const derivedReady = checks.length > 0 ? checks.every((check) => check.status !== "fail") : true;

  const notes = [
    ...toStringArray(record.notes),
    ...toStringArray(record.warnings),
    ...toStringArray(record.errors),
    ...toStringArray(record.hints),
  ];

  return {
    ready: explicitReady ?? derivedReady,
    repoPath:
      toStringValue(record.repoPath) ??
      toStringValue(record.repo_root) ??
      toStringValue(record.path) ??
      undefined,
    branch:
      toStringValue(record.branch) ??
      toStringValue(record.currentBranch) ??
      toStringValue(record.head) ??
      null,
    checks,
    notes,
  };
}

export function normalizeReleaseStartResult(value: unknown): ReleaseStartResult {
  const record = toRecord(value) ?? {};
  const releaseId =
    toStringValue(record.releaseId) ??
    toStringValue(record.release_id) ??
    toStringValue(record.runId) ??
    toStringValue(record.jobId) ??
    toStringValue(record.id) ??
    `release-${Date.now()}`;

  const status =
    toStringValue(record.status) ??
    toStringValue(record.state) ??
    "queued";

  return {
    releaseId,
    status,
    message: toStringValue(record.message) ?? undefined,
  };
}

export function normalizeReleaseStatusResult(value: unknown, fallbackReleaseId?: string): ReleaseStatusResult {
  const record = toRecord(value) ?? {};
  const releaseId =
    toStringValue(record.releaseId) ??
    toStringValue(record.release_id) ??
    toStringValue(record.runId) ??
    toStringValue(record.jobId) ??
    toStringValue(record.id) ??
    fallbackReleaseId ??
    "";

  const status =
    toStringValue(record.status) ??
    toStringValue(record.state) ??
    toStringValue(record.result) ??
    "unknown";
  const phase =
    toStringValue(record.phase) ??
    toStringValue(record.stage) ??
    toStringValue(record.step) ??
    undefined;

  const logs = normalizeReleaseLogs(record);
  const assetsRaw = Array.isArray(record.assets)
    ? record.assets
    : Array.isArray(record.artifacts)
      ? record.artifacts
      : Array.isArray(record.files)
        ? record.files
        : [];
  const linksRaw = Array.isArray(record.links)
    ? record.links
    : Array.isArray(record.urls)
      ? record.urls
      : Array.isArray(record.releaseLinks)
        ? record.releaseLinks
        : [];

  const assets: ReleaseAsset[] = [];
  for (let i = 0; i < assetsRaw.length; i += 1) {
    const asset = normalizeReleaseAsset(assetsRaw[i], i);
    if (!asset) continue;
    if (assets.some((entry) => entry.id === asset.id)) continue;
    assets.push(asset);
  }

  const links: ReleaseAsset[] = [];
  for (let i = 0; i < linksRaw.length; i += 1) {
    const link = normalizeReleaseAsset(linksRaw[i], i);
    if (!link) continue;
    if (links.some((entry) => entry.id === link.id)) continue;
    links.push(link);
  }

  const errorRecord = toRecord(record.error);
  const error =
    toStringValue(record.error) ??
    (errorRecord ? toStringValue(errorRecord.message) : null) ??
    undefined;

  return {
    releaseId,
    status,
    ...(phase ? { phase } : {}),
    logs,
    assets,
    links,
    ...(error ? { error } : {}),
    ...(toIsoDate(record.updatedAt ?? record.updated_at ?? record.ts ?? record.time) ? {
      updatedAt: toIsoDate(record.updatedAt ?? record.updated_at ?? record.ts ?? record.time) ?? undefined,
    } : {}),
    ...(toIsoDate(record.completedAt ?? record.completed_at ?? record.finishedAt) ? {
      completedAt: toIsoDate(record.completedAt ?? record.completed_at ?? record.finishedAt) ?? undefined,
    } : {}),
  };
}

export function mergeReleaseStatus(
  current: ReleaseStatusResult | null,
  incoming: ReleaseStatusResult,
): ReleaseStatusResult {
  if (!current || current.releaseId !== incoming.releaseId) {
    return incoming;
  }

  const logs = [...current.logs];
  for (const entry of incoming.logs) {
    if (!logs.some((log) => log.id === entry.id)) {
      logs.push(entry);
    }
  }
  logs.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const assets = [...current.assets];
  for (const asset of incoming.assets) {
    if (!assets.some((item) => item.id === asset.id)) {
      assets.push(asset);
    }
  }

  const links = [...current.links];
  for (const link of incoming.links) {
    if (!links.some((item) => item.id === link.id)) {
      links.push(link);
    }
  }

  return {
    ...current,
    ...incoming,
    logs,
    assets,
    links,
  };
}

export function isReleaseTerminalStatus(status: string | null | undefined): boolean {
  const value = status?.trim().toLowerCase() ?? "";
  if (!value) return false;
  return (
    value.includes("completed") ||
    value.includes("success") ||
    value.includes("failed") ||
    value.includes("cancel") ||
    value.includes("error")
  );
}
