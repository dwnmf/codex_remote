import { describe, expect, test } from "bun:test";

import { extractTurnId } from "../utils/protocol";

describe("protocol utils", () => {
  test("extractTurnId reads turnId from result", () => {
    const message = {
      result: {
        turnId: "turn-from-result",
      },
    } as Record<string, unknown>;

    expect(extractTurnId(message)).toBe("turn-from-result");
  });

  test("extractTurnId reads numeric turn_id from result", () => {
    const message = {
      result: {
        turn_id: 42,
      },
    } as Record<string, unknown>;

    expect(extractTurnId(message)).toBe("42");
  });
});
