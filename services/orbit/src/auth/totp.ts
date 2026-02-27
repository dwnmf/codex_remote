import { base64UrlEncode } from "./utils";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD_SEC = 30;
const DEFAULT_ALGORITHM = "SHA1";

export interface TotpConfig {
  digits?: number;
  periodSec?: number;
}

export interface TotpVerificationResult {
  valid: boolean;
  step: number | null;
}

function normalizeBase32(input: string): string {
  return input.toUpperCase().replace(/[\s=]/g, "");
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(input: string): Uint8Array {
  const normalized = normalizeBase32(input);
  if (!normalized) {
    throw new Error("Empty base32 secret.");
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("Invalid base32 secret.");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

function toCounterBytes(step: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let counter = BigInt(step);
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = Number(counter & 0xffn);
    counter >>= 8n;
  }
  return bytes;
}

function normalizeCode(code: string): string {
  return code.replace(/\s|-/g, "");
}

function normalizeWindow(window: number | undefined): number {
  const raw = window ?? 1;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    throw new RangeError("TOTP window must be a finite non-negative integer.");
  }
  return raw;
}

async function hmacSha1(keyBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, message as BufferSource);
  return new Uint8Array(signature);
}

async function generateHotp(secretBase32: string, step: number, digits: number): Promise<string> {
  const keyBytes = decodeBase32(secretBase32);
  const digest = await hmacSha1(keyBytes, toCounterBytes(step));
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(value % mod).padStart(digits, "0");
}

function currentStep(nowMs: number, periodSec: number): number {
  return Math.floor(nowMs / 1000 / periodSec);
}

export function generateTotpSecret(byteLength = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return encodeBase32(bytes);
}

export async function generateTotpCode(
  secretBase32: string,
  options: TotpConfig & { nowMs?: number } = {}
): Promise<string> {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const periodSec = options.periodSec ?? DEFAULT_PERIOD_SEC;
  const step = currentStep(options.nowMs ?? Date.now(), periodSec);
  return await generateHotp(secretBase32, step, digits);
}

export async function verifyTotpCode(
  secretBase32: string,
  code: string,
  options: TotpConfig & { nowMs?: number; window?: number } = {}
): Promise<TotpVerificationResult> {
  const normalizedCode = normalizeCode(code);
  const digits = options.digits ?? DEFAULT_DIGITS;
  if (!/^\d+$/.test(normalizedCode) || normalizedCode.length !== digits) {
    return { valid: false, step: null };
  }

  const periodSec = options.periodSec ?? DEFAULT_PERIOD_SEC;
  const step = currentStep(options.nowMs ?? Date.now(), periodSec);
  const window = normalizeWindow(options.window);

  for (let offset = -window; offset <= window; offset += 1) {
    const candidateStep = step + offset;
    if (candidateStep < 0) continue;
    const expected = await generateHotp(secretBase32, candidateStep, digits);
    if (expected === normalizedCode) {
      return { valid: true, step: candidateStep };
    }
  }

  return { valid: false, step: null };
}

export function buildTotpUri(args: {
  secretBase32: string;
  accountName: string;
  issuer?: string;
  digits?: number;
  periodSec?: number;
}): string {
  const issuer = (args.issuer ?? "Codex Remote").trim() || "Codex Remote";
  const digits = args.digits ?? DEFAULT_DIGITS;
  const periodSec = args.periodSec ?? DEFAULT_PERIOD_SEC;
  const label = `${issuer}:${args.accountName}`;
  const params = new URLSearchParams({
    secret: args.secretBase32,
    issuer,
    algorithm: DEFAULT_ALGORITHM,
    digits: String(digits),
    period: String(periodSec),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function createTotpSetupTokenPayload(args: {
  name: string;
  displayName: string;
  secretBase32: string;
  digits?: number;
  periodSec?: number;
  userId?: string;
}): {
  name: string;
  displayName: string;
  secretBase32: string;
  digits: number;
  periodSec: number;
  nonce: string;
  userId?: string;
} {
  const payload = {
    name: args.name,
    displayName: args.displayName,
    secretBase32: args.secretBase32,
    digits: args.digits ?? DEFAULT_DIGITS,
    periodSec: args.periodSec ?? DEFAULT_PERIOD_SEC,
    nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    userId: args.userId,
  };
  return args.userId ? payload : { ...payload, userId: undefined };
}
