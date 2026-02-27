import { describe, expect, test } from "bun:test";

import { verifyJwtHs256 } from "../utils/jwt";

function encodeBase64UrlText(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createHs256Token(secret: string, payload: Record<string, unknown>): Promise<string> {
  const headerPart = encodeBase64UrlText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadPart = encodeBase64UrlText(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  );
  const signaturePart = encodeBase64UrlBytes(new Uint8Array(signatureBuffer));
  return `${headerPart}.${payloadPart}.${signaturePart}`;
}

describe("jwt utils", () => {
  const secret = "test-web-secret";
  const expected = {
    issuer: "codex-remote-auth",
    audience: "codex-remote-web",
  };

  test("verifies a valid HS256 token", async () => {
    const token = await createHs256Token(secret, {
      iss: expected.issuer,
      aud: expected.audience,
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: "user-123",
    });

    const valid = await verifyJwtHs256(token, secret, expected);
    expect(valid).toBe(true);
  });

  test("rejects tokens with extra dot-separated segments", async () => {
    const token = await createHs256Token(secret, {
      iss: expected.issuer,
      aud: expected.audience,
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: "user-123",
    });

    const tampered = `${token}.extra-segment`;
    const valid = await verifyJwtHs256(tampered, secret, expected);
    expect(valid).toBe(false);
  });
});
