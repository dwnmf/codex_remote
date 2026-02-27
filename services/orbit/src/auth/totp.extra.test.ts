import { describe, expect, test } from "bun:test";

import { generateTotpCode, verifyTotpCode } from "./totp";

describe("totp hardening", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  test("rejects non-finite verification windows", async () => {
    const nowMs = 1_710_000_000_000;
    const code = await generateTotpCode(secret, { nowMs, digits: 6, periodSec: 30 });

    await expect(
      verifyTotpCode(secret, code, {
        nowMs,
        digits: 6,
        periodSec: 30,
        window: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow("TOTP window must be a finite non-negative integer.");
  });

  test("rejects fractional verification windows", async () => {
    const nowMs = 1_710_000_000_000;
    const code = await generateTotpCode(secret, { nowMs, digits: 6, periodSec: 30 });

    await expect(
      verifyTotpCode(secret, code, {
        nowMs,
        digits: 6,
        periodSec: 30,
        window: 1.5,
      })
    ).rejects.toThrow("TOTP window must be a finite non-negative integer.");
  });

  test("continues to verify when window is valid", async () => {
    const nowMs = 1_710_000_000_000;
    const code = await generateTotpCode(secret, { nowMs, digits: 6, periodSec: 30 });

    const result = await verifyTotpCode(secret, code, {
      nowMs,
      digits: 6,
      periodSec: 30,
      window: 1,
    });

    expect(result).toEqual({ valid: true, step: Math.floor(nowMs / 30_000) });
  });
});
