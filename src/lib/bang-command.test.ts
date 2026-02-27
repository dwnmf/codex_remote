import { describe, expect, test } from "bun:test";
import { buildBangTerminalPrompt, parseBangTerminalCommand } from "./bang-command";

describe("parseBangTerminalCommand", () => {
  test("returns null for non-bang input", () => {
    expect(parseBangTerminalCommand("run tests")).toBeNull();
  });

  test("parses plain bang command", () => {
    expect(parseBangTerminalCommand("!npm test")).toEqual({
      shell: null,
      command: "npm test",
    });
  });

  test("parses explicit shell aliases", () => {
    expect(parseBangTerminalCommand("!pwsh Get-ChildItem")).toEqual({
      shell: "pwsh",
      command: "Get-ChildItem",
    });
    expect(parseBangTerminalCommand("!powershell.exe Get-ChildItem")).toEqual({
      shell: "pwsh",
      command: "Get-ChildItem",
    });
    expect(parseBangTerminalCommand("!cmd dir")).toEqual({
      shell: "cmd",
      command: "dir",
    });
  });

  test("accepts shell prefix with colon", () => {
    expect(parseBangTerminalCommand("!bash: ls -la")).toEqual({
      shell: "bash",
      command: "ls -la",
    });
  });

  test("accepts shell prefix with colon and no following space", () => {
    expect(parseBangTerminalCommand("!bash:ls -la")).toEqual({
      shell: "bash",
      command: "ls -la",
    });
  });

  test("accepts shell prefix with whitespace before colon", () => {
    expect(parseBangTerminalCommand("!bash : ls -la")).toEqual({
      shell: "bash",
      command: "ls -la",
    });
  });

  test("accepts quoted shell token", () => {
    expect(parseBangTerminalCommand("!\"pwsh\": Get-ChildItem")).toEqual({
      shell: "pwsh",
      command: "Get-ChildItem",
    });
  });

  test("detects missing command", () => {
    expect(parseBangTerminalCommand("!")).toEqual({
      shell: null,
      command: "",
    });
    expect(parseBangTerminalCommand("!pwsh")).toEqual({
      shell: "pwsh",
      command: "",
    });
    expect(parseBangTerminalCommand("!pwsh:")).toEqual({
      shell: "pwsh",
      command: "",
    });
  });

  test("keeps unknown shell-like prefixes as plain command text", () => {
    expect(parseBangTerminalCommand("!npm:test")).toEqual({
      shell: null,
      command: "npm:test",
    });
  });
});

describe("buildBangTerminalPrompt", () => {
  test("includes command and mode header", () => {
    const parsed = parseBangTerminalCommand("!echo hello");
    expect(parsed).not.toBeNull();
    const prompt = buildBangTerminalPrompt(parsed!);
    expect(prompt).toContain("TERMINAL COMMAND MODE");
    expect(prompt).toContain("<command>echo hello</command>");
  });
});
