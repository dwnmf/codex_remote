import type { Settings } from "./types.ts";

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function lower(value: string): string {
  return value.trim().toLowerCase();
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const decoded = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

export function randomId(size = 32): string {
  return base64UrlEncode(randomBytes(size));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

export function parseBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  if (!headerValue.toLowerCase().startsWith("bearer ")) return null;
  const token = headerValue.slice(7).trim();
  return token || null;
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function getRequestToken(req: Request): string | null {
  const headerToken = parseBearerToken(req.headers.get("authorization"));
  if (headerToken) return headerToken;
  const url = new URL(req.url);
  return asString(url.searchParams.get("token"));
}

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function textResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers });
}

export function corsHeaders(settings: Settings, req: Request): Headers {
  const origin = req.headers.get("origin");
  const headers = new Headers();

  if (origin && isOriginAllowed(settings, origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  } else if (settings.corsOrigins.includes("*")) {
    headers.set("access-control-allow-origin", "*");
  }

  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type");
  headers.set("access-control-max-age", "86400");
  return headers;
}

export function jsonWithCors(settings: Settings, req: Request, body: unknown, status = 200): Response {
  return jsonResponse(body, status, corsHeaders(settings, req));
}

export function emptyWithCors(settings: Settings, req: Request, status = 204): Response {
  return new Response(null, { status, headers: corsHeaders(settings, req) });
}

export function isOriginAllowed(settings: Settings, origin: string | null): boolean {
  if (!origin) return false;
  if (settings.corsOrigins.includes("*")) return true;
  return settings.corsOrigins.includes(origin);
}

export function resolveRpId(settings: Settings, origin: string): string {
  if (settings.passkeyRpId) return settings.passkeyRpId;
  if (settings.passkeyOrigin) {
    const parsed = new URL(settings.passkeyOrigin);
    if (parsed.hostname) return parsed.hostname;
  }
  const parsed = new URL(origin);
  if (!parsed.hostname) {
    throw new Error("Unable to derive RP ID");
  }
  return parsed.hostname;
}

export function extractChallengeFromClientData(clientDataJson: unknown): string | null {
  if (typeof clientDataJson !== "string" || !clientDataJson) return null;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(clientDataJson));
    const parsed = JSON.parse(decoded) as { challenge?: unknown };
    return asString(parsed.challenge);
  } catch {
    return null;
  }
}

export async function parseJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function getDeviceVerificationUrl(settings: Settings, req: Request): string {
  if (settings.deviceVerificationUrl) return settings.deviceVerificationUrl;
  const url = new URL(req.url);
  return `${url.origin}/device`;
}
