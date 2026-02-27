import type { OrbitArtifact, OrbitArtifactLink, OrbitArtifactsListResult, OrbitMultiDispatchPayload } from "./types";

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toIdValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return toStringValue(value);
}

function toIsoDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return new Date().toISOString();
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && trimmed.length >= 10) {
      const millis = trimmed.length >= 13 ? asNumber : asNumber * 1_000;
      return new Date(millis).toISOString();
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toStringValue(item))
    .filter((item): item is string => Boolean(item));
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function stripQuoted(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function uniqStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().replace(/^\.?[\\/]/, "").replace(/\\/g, "/");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractCommandPaths(command: string): string[] {
  const paths: string[] = [];
  const pathFlag = /(?:^|\s)-Path\s+("[^"]+"|'[^']+'|[^\s]+)/gi;
  let match = pathFlag.exec(command);
  while (match) {
    const candidate = stripQuoted(match[1] ?? "");
    if (candidate) paths.push(candidate);
    match = pathFlag.exec(command);
  }

  const redirect = />\s*("[^"]+"|'[^']+'|[^\s]+)/g;
  match = redirect.exec(command);
  while (match) {
    const candidate = stripQuoted(match[1] ?? "");
    if (candidate) paths.push(candidate);
    match = redirect.exec(command);
  }

  return uniqStrings(paths);
}

function extractPayloadPaths(payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];

  const fromChanges = toRecordArray(payload.changes)
    .map((entry) => toStringValue(entry.path))
    .filter((value): value is string => Boolean(value));

  const command = toStringValue(payload.command);
  const fromCommand = command ? extractCommandPaths(command) : [];
  return uniqStrings([...fromChanges, ...fromCommand]);
}

function humanizeArtifactType(rawType: string): string {
  const normalized = rawType.trim().toLowerCase();
  if (!normalized) return "artifact";
  const map: Record<string, string> = {
    command: "command",
    commandexecution: "command",
    file: "file change",
    filechange: "file change",
    image: "image",
    imageview: "image",
    tool: "tool call",
    mcptoolcall: "tool call",
    websearch: "web search",
    collabagenttoolcall: "collab call",
  };
  return map[normalized] ?? normalized.replace(/[-_]+/g, " ");
}

function normalizeArtifactLink(value: unknown): OrbitArtifactLink | null {
  if (typeof value === "string") {
    const href = toStringValue(value);
    if (!href) return null;
    return { label: href, href };
  }
  const record = toRecord(value);
  if (!record) return null;
  const href =
    toStringValue(record.href) ??
    toStringValue(record.url) ??
    toStringValue(record.link) ??
    toStringValue(record.value);
  if (!href) return null;
  return {
    label: toStringValue(record.label) ?? toStringValue(record.title) ?? href,
    href,
  };
}

function normalizeArtifactLinks(record: Record<string, unknown>): OrbitArtifactLink[] {
  const linkCandidates = [
    record.links,
    record.assets,
    record.urls,
    record.references,
  ];
  const links: OrbitArtifactLink[] = [];
  for (const candidate of linkCandidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const normalized = normalizeArtifactLink(entry);
      if (!normalized) continue;
      if (links.some((link) => link.href === normalized.href)) continue;
      links.push(normalized);
    }
  }
  return links;
}

export function normalizeArtifact(value: unknown, fallbackThreadId?: string): OrbitArtifact | null {
  const record = toRecord(value);
  if (!record) return null;

  const id =
    toIdValue(record.id) ??
    toIdValue(record.artifactId) ??
    toIdValue(record.artifact_id);
  const threadId =
    toStringValue(record.threadId) ??
    toStringValue(record.thread_id) ??
    fallbackThreadId ??
    null;

  if (!id || !threadId) return null;

  const type =
    toStringValue(record.type) ??
    toStringValue(record.artifactType) ??
    toStringValue(record.artifact_type) ??
    toStringValue(record.itemType) ??
    toStringValue(record.item_type) ??
    toStringValue(record.kind) ??
    toStringValue(record.channel) ??
    "artifact";
  const payloadRecord = toRecord(record.payload);
  const extractedPaths = extractPayloadPaths(payloadRecord);
  const rawSummary =
    toStringValue(record.summary) ??
    toStringValue(record.description) ??
    toStringValue(record.text) ??
    undefined;
  const summary = rawSummary ?? (extractedPaths.length > 0 ? extractedPaths.join(", ") : undefined);
  const titleCandidate =
    toStringValue(record.title) ??
    toStringValue(record.label) ??
    toStringValue(record.name);
  const typeLabel = humanizeArtifactType(type);
  const title =
    titleCandidate ??
    (rawSummary && rawSummary.length <= 96 ? rawSummary : typeLabel);
  const status = toStringValue(record.status) ?? toStringValue(record.state) ?? undefined;
  const createdAt = toIsoDate(
    record.createdAt ?? record.created_at ?? record.timestamp ?? record.ts ?? record.time,
  );
  const links = normalizeArtifactLinks(record);
  const metadataSeed = toRecord(record.metadata) ?? {};
  const metadata: Record<string, unknown> = {
    ...metadataSeed,
    ...(payloadRecord ? { payload: payloadRecord } : {}),
    ...(extractedPaths.length > 0 ? { paths: extractedPaths } : {}),
  };

  return {
    id,
    threadId,
    type,
    title,
    ...(summary ? { summary } : {}),
    createdAt,
    ...(status ? { status } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function normalizeArtifactsListResult(value: unknown, threadId: string): OrbitArtifactsListResult {
  let entries: unknown[] = [];
  if (Array.isArray(value)) {
    entries = value;
  } else {
    const record = toRecord(value);
    if (record) {
      if (Array.isArray(record.artifacts)) entries = record.artifacts;
      else if (Array.isArray(record.items)) entries = record.items;
      else if (Array.isArray(record.timeline)) entries = record.timeline;
      else if (Array.isArray(record.data)) entries = record.data;
    }
  }

  const normalized: OrbitArtifact[] = [];
  for (const entry of entries) {
    const artifact = normalizeArtifact(entry, threadId);
    if (!artifact) continue;
    const existingIndex = normalized.findIndex((item) => item.id === artifact.id);
    if (existingIndex >= 0) {
      normalized[existingIndex] = artifact;
    } else {
      normalized.push(artifact);
    }
  }

  normalized.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { artifacts: normalized };
}

function normalizeDispatchEntry(value: unknown): OrbitMultiDispatchPayload | null {
  const record = toRecord(value);
  if (!record) return null;

  const channel =
    toStringValue(record.channel) ??
    toStringValue(record.topic) ??
    toStringValue(record.type);
  if (!channel) return null;

  const dataRecord =
    toRecord(record.data) ??
    toRecord(record.payload) ??
    toRecord(record.body) ??
    record;

  if (!dataRecord) return null;

  return {
    channel,
    threadId: toStringValue(record.threadId) ?? toStringValue(record.thread_id) ?? undefined,
    releaseId: toStringValue(record.releaseId) ?? toStringValue(record.release_id) ?? undefined,
    event: toStringValue(record.event) ?? toStringValue(record.action) ?? undefined,
    data: dataRecord,
  };
}

export function extractMultiDispatchPayloads(message: Record<string, unknown>): OrbitMultiDispatchPayload[] {
  if (message.type !== "orbit.multi-dispatch") return [];

  const direct = normalizeDispatchEntry(message);
  const listCandidates = [
    message.dispatches,
    message.events,
    message.items,
    message.payloads,
  ];

  const payloads: OrbitMultiDispatchPayload[] = [];
  if (direct && direct.data !== message) {
    payloads.push(direct);
  }

  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const normalized = normalizeDispatchEntry(entry);
      if (normalized) payloads.push(normalized);
    }
  }

  if (payloads.length === 0 && direct) {
    payloads.push(direct);
  }

  return payloads;
}

export function extractArtifactIdsFromDispatch(payload: OrbitMultiDispatchPayload): string[] {
  const data = payload.data;
  const directId =
    toStringValue(data.artifactId) ??
    toStringValue(data.artifact_id) ??
    toStringValue(data.id);
  const ids = new Set<string>();
  if (directId) ids.add(directId);
  for (const id of toStringArray(data.artifactIds ?? data.artifact_ids)) {
    ids.add(id);
  }
  return Array.from(ids);
}
