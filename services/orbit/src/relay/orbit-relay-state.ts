import { asRecord, extractAnchorId, extractMethod, extractThreadId, extractTurnId } from "../utils/protocol";

export const MAX_STORED_THREADS = 200;
export const MAX_RECENT_MESSAGES = 60;
export const MAX_RECENT_MESSAGE_BYTES = 16_000;
export const MAX_ARTIFACTS_PER_THREAD = 40;
export const MULTI_DISPATCH_TIMEOUT_MS = 20_000;

export interface RelayTurnState {
  id: string | null;
  status: string | null;
  updatedAt: string;
}

export interface RelayArtifact {
  id: string;
  itemId: string;
  threadId: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface RelayThreadState {
  threadId: string;
  anchorId: string | null;
  turn: RelayTurnState;
  recentMessages: string[];
  artifacts: RelayArtifact[];
  updatedAt: string;
}

export interface ThreadStateMutation {
  threadId: string;
  anchorId?: string | null;
  turnId?: string | null;
  turnStatus?: string | null;
  recentMessage?: string;
  artifact?: RelayArtifact;
}

export interface MultiDispatchRequest {
  requestId: string | number | null;
  threadId: string | null;
  anchorIds: string[];
  childRequest: Record<string, unknown>;
}

export interface MultiDispatchResultEntry {
  anchorId: string;
  childId: string | number;
  ok: boolean;
  result?: unknown;
  error?: unknown;
}

export interface MultiDispatchAggregate extends Record<string, unknown> {
  type: "orbit.multi-dispatch.result";
  id: string | number | null;
  threadId: string | null;
  results: MultiDispatchResultEntry[];
  summary: {
    total: number;
    ok: number;
    failed: number;
    timedOut: number;
  };
}

export function clampStringBytes(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  return encoded.length <= maxBytes ? value : "";
}

export function upsertArtifact(
  artifacts: RelayArtifact[],
  next: RelayArtifact,
  maxArtifacts = MAX_ARTIFACTS_PER_THREAD
): RelayArtifact[] {
  const deduped = artifacts.filter((artifact) => artifact.id !== next.id);
  deduped.push(next);
  if (deduped.length <= maxArtifacts) return deduped;
  return deduped.slice(deduped.length - maxArtifacts);
}

export function appendRecentMessage(
  messages: string[],
  raw: string,
  maxMessages = MAX_RECENT_MESSAGES,
  maxBytes = MAX_RECENT_MESSAGE_BYTES
): string[] {
  const clamped = clampStringBytes(raw, maxBytes);
  if (!clamped) return messages;
  const next = [...messages, clamped];
  if (next.length <= maxMessages) return next;
  return next.slice(next.length - maxMessages);
}

export function createEmptyThreadState(threadId: string, nowIso = new Date().toISOString()): RelayThreadState {
  return {
    threadId,
    anchorId: null,
    turn: {
      id: null,
      status: null,
      updatedAt: nowIso,
    },
    recentMessages: [],
    artifacts: [],
    updatedAt: nowIso,
  };
}

export function applyThreadStateMutation(
  current: RelayThreadState,
  mutation: ThreadStateMutation,
  nowIso = new Date().toISOString()
): RelayThreadState {
  const next: RelayThreadState = {
    ...current,
    turn: { ...current.turn },
    recentMessages: [...current.recentMessages],
    artifacts: [...current.artifacts],
    updatedAt: nowIso,
  };

  if (mutation.anchorId !== undefined) {
    next.anchorId = mutation.anchorId;
  }

  if (mutation.turnId !== undefined) {
    next.turn.id = mutation.turnId;
    next.turn.updatedAt = nowIso;
  }

  if (mutation.turnStatus !== undefined) {
    next.turn.status = mutation.turnStatus;
    next.turn.updatedAt = nowIso;
  }

  if (mutation.recentMessage !== undefined) {
    next.recentMessages = appendRecentMessage(next.recentMessages, mutation.recentMessage);
  }

  if (mutation.artifact) {
    next.artifacts = upsertArtifact(next.artifacts, mutation.artifact);
  }

  return next;
}

function parseAnchorIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

function toRpcRequest(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.method !== "string" || !record.method.trim()) return null;
  return { ...record };
}

export function parseMultiDispatchRequest(message: Record<string, unknown>): MultiDispatchRequest | null {
  if (message.type !== "orbit.multi-dispatch") return null;

  const childRequest =
    toRpcRequest(message.request)
    ?? toRpcRequest(message.rpc);
  if (!childRequest) return null;

  const requestId =
    typeof message.id === "string" || typeof message.id === "number"
      ? message.id
      : null;

  const threadId = extractThreadId(message) ?? extractThreadId(childRequest);
  const anchorIds = parseAnchorIds(message.anchorIds ?? message.anchors);

  return {
    requestId,
    threadId,
    anchorIds,
    childRequest,
  };
}

export function buildMultiDispatchAggregate(
  requestId: string | number | null,
  threadId: string | null,
  results: MultiDispatchResultEntry[]
): MultiDispatchAggregate {
  const ok = results.filter((entry) => entry.ok).length;
  const timedOut = results.filter((entry) => {
    const record = asRecord(entry.error);
    const data = asRecord(record?.data);
    return data?.code === "timeout";
  }).length;

  return {
    type: "orbit.multi-dispatch.result",
    id: requestId,
    threadId,
    results,
    summary: {
      total: results.length,
      ok,
      failed: results.length - ok,
      timedOut,
    },
  };
}

function isTerminalMethod(method: string): boolean {
  return method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled";
}

function inferTurnStatus(message: Record<string, unknown>): string | null {
  const params = asRecord(message.params);
  const turnRecord = asRecord(params?.turn);

  const statusCandidates = [
    turnRecord?.status,
    params?.turnStatus,
    params?.turn_status,
  ];

  for (const candidate of statusCandidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  const method = extractMethod(message);
  if (!method) return null;
  if (method === "turn/started") return "InProgress";
  if (method === "turn/completed") return "Completed";
  if (method === "turn/failed") return "Failed";
  if (method === "turn/cancelled") return "Cancelled";
  return null;
}

function shouldPersistRecentMessage(message: Record<string, unknown>): boolean {
  const method = extractMethod(message);
  if (!method) return false;
  if (method.startsWith("item/")) return true;
  if (method.startsWith("turn/")) return true;
  return false;
}

export function extractArtifactFromMessage(
  message: Record<string, unknown>,
  nowIso = new Date().toISOString()
): RelayArtifact | null {
  const method = extractMethod(message);
  if (method !== "item/completed") return null;

  const params = asRecord(message.params);
  const item = asRecord(params?.item);
  if (!item) return null;

  const threadId = extractThreadId(message);
  if (!threadId) return null;

  const itemIdRaw = item.id;
  const itemId =
    typeof itemIdRaw === "string" && itemIdRaw.trim()
      ? itemIdRaw.trim()
      : typeof itemIdRaw === "number"
        ? String(itemIdRaw)
        : null;
  if (!itemId) return null;

  const typeRaw = item.type;
  const type = typeof typeRaw === "string" && typeRaw.trim() ? typeRaw.trim() : "unknown";

  return {
    id: `${threadId}:${itemId}`,
    threadId,
    itemId,
    type,
    createdAt: nowIso,
    payload: item,
  };
}

export function buildThreadStateMutationFromMessage(
  message: Record<string, unknown>,
  rawMessage: string,
  nowIso = new Date().toISOString()
): ThreadStateMutation | null {
  const threadId = extractThreadId(message);
  if (!threadId) return null;

  const mutation: ThreadStateMutation = { threadId };
  const anchorId = extractAnchorId(message);
  if (anchorId) mutation.anchorId = anchorId;

  const turnId = extractTurnId(message);
  if (turnId) mutation.turnId = turnId;

  const turnStatus = inferTurnStatus(message);
  if (turnStatus) mutation.turnStatus = turnStatus;

  if (shouldPersistRecentMessage(message)) {
    mutation.recentMessage = rawMessage;
  }

  const artifact = extractArtifactFromMessage(message, nowIso);
  if (artifact) {
    mutation.artifact = artifact;
  }

  // If this message is terminal, keep it in history even when method inference failed.
  const method = extractMethod(message);
  if (!mutation.recentMessage && method && isTerminalMethod(method)) {
    mutation.recentMessage = rawMessage;
  }

  return mutation;
}

export function normalizeStoredThreadState(value: unknown): RelayThreadState | null {
  const record = asRecord(value);
  if (!record) return null;

  const threadId = typeof record.threadId === "string" ? record.threadId : "";
  if (!threadId.trim()) return null;

  const nowIso = new Date().toISOString();
  const turnRecord = asRecord(record.turn);
  const recentMessagesRaw = Array.isArray(record.recentMessages)
    ? record.recentMessages.filter((entry): entry is string => typeof entry === "string")
    : [];
  const recentMessages = recentMessagesRaw.slice(Math.max(0, recentMessagesRaw.length - MAX_RECENT_MESSAGES));
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => {
          const payload = asRecord(entry.payload) ?? {};
          const itemIdRaw = entry.itemId;
          const itemId =
            typeof itemIdRaw === "string"
              ? itemIdRaw
              : typeof itemIdRaw === "number"
                ? String(itemIdRaw)
                : "";
          if (!itemId) return null;
          return {
            id: typeof entry.id === "string" ? entry.id : `${threadId}:${itemId}`,
            itemId,
            threadId,
            type: typeof entry.type === "string" && entry.type.trim() ? entry.type : "unknown",
            createdAt: typeof entry.createdAt === "string" && entry.createdAt.trim() ? entry.createdAt : nowIso,
            payload,
          } as RelayArtifact;
        })
        .filter((entry): entry is RelayArtifact => entry !== null)
    : [];

  return {
    threadId,
    anchorId: typeof record.anchorId === "string" && record.anchorId.trim() ? record.anchorId : null,
    turn: {
      id: typeof turnRecord?.id === "string" && turnRecord.id.trim() ? turnRecord.id : null,
      status: typeof turnRecord?.status === "string" && turnRecord.status.trim() ? turnRecord.status : null,
      updatedAt:
        typeof turnRecord?.updatedAt === "string" && turnRecord.updatedAt.trim()
          ? turnRecord.updatedAt
          : nowIso,
    },
    recentMessages,
    artifacts: artifacts.slice(Math.max(0, artifacts.length - MAX_ARTIFACTS_PER_THREAD)),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : nowIso,
  };
}
