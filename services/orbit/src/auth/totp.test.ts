import { describe, expect, test } from "bun:test";

import { buildTotpUri, generateTotpCode, verifyTotpCode } from "./totp";

describe("totp unit", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"

  test("matches RFC6238 SHA1 vectors (8 digits)", async () => {
    const vectors: Array<{ sec: number; code: string }> = [
      { sec: 59, code: "94287082" },
      { sec: 1111111109, code: "07081804" },
      { sec: 1111111111, code: "14050471" },
      { sec: 1234567890, code: "89005924" },
      { sec: 2000000000, code: "69279037" },
      { sec: 20000000000, code: "65353130" },
    ];

    for (const vector of vectors) {
      const code = await generateTotpCode(secret, {
        nowMs: vector.sec * 1000,
        digits: 8,
        periodSec: 30,
      });
      expect(code).toBe(vector.code);
    }
  });

  test("verifies with ±1 step window", async () => {
    const nowMs = 1_710_000_000_000;
    const previousStepCode = await generateTotpCode(secret, {
      nowMs: nowMs - 30_000,
      digits: 6,
      periodSec: 30,
    });

    const verified = await verifyTotpCode(secret, previousStepCode, {
      nowMs,
      digits: 6,
      periodSec: 30,
      window: 1,
    });
    expect(verified.valid).toBe(true);
    expect(typeof verified.step).toBe("number");
  });

  test("builds otpauth URI", () => {
    const uri = buildTotpUri({
      secretBase32: secret,
      accountName: "alice",
      issuer: "Codex Remote",
      digits: 6,
      periodSec: 30,
    });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri.includes("secret=" + secret)).toBe(true);
    expect(uri.includes("issuer=Codex+Remote")).toBe(true);
  });
});
