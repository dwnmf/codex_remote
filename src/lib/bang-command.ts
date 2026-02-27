export type TerminalShell = "pwsh" | "cmd" | "bash" | "sh" | "zsh" | "fish";

export interface BangTerminalCommand {
  shell: TerminalShell | null;
  command: string;
}

const SHELL_ALIASES: Record<string, TerminalShell> = {
  pwsh: "pwsh",
  powershell: "pwsh",
  "powershell.exe": "pwsh",
  cmd: "cmd",
  "cmd.exe": "cmd",
  bash: "bash",
  sh: "sh",
  zsh: "zsh",
  fish: "fish",
};

const SHELL_HINTS: Record<TerminalShell, string> = {
  pwsh: "Use PowerShell (pwsh).",
  cmd: "Use Windows Command Prompt (cmd.exe).",
  bash: "Use bash.",
  sh: "Use sh.",
  zsh: "Use zsh.",
  fish: "Use fish.",
};

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function normalizeShell(raw: string): TerminalShell | null {
  const trimmed = stripMatchingQuotes(raw).toLowerCase();
  return SHELL_ALIASES[trimmed] ?? null;
}

export function parseBangTerminalCommand(input: string): BangTerminalCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("!")) return null;

  const rest = trimmed.slice(1).trim();
  if (!rest) return { shell: null, command: "" };

  const firstWhitespace = rest.search(/\s/);
  const firstColon = rest.indexOf(":");
  const tokenEnd =
    firstWhitespace < 0
      ? firstColon
      : firstColon < 0
        ? firstWhitespace
        : Math.min(firstWhitespace, firstColon);
  const token = tokenEnd < 0 ? rest : rest.slice(0, tokenEnd);

  const shell = normalizeShell(token);
  if (!shell) {
    return { shell: null, command: rest };
  }

  let commandStart = tokenEnd < 0 ? rest.length : tokenEnd;
  while (commandStart < rest.length && /\s/.test(rest[commandStart])) {
    commandStart += 1;
  }
  if (rest[commandStart] === ":") {
    commandStart += 1;
    while (commandStart < rest.length && /\s/.test(rest[commandStart])) {
      commandStart += 1;
    }
  }

  return {
    shell,
    command: rest.slice(commandStart).trim(),
  };
}

export function buildBangTerminalPrompt(parsed: BangTerminalCommand): string {
  const shellHint = parsed.shell
    ? SHELL_HINTS[parsed.shell]
    : "Use the host OS default shell (Windows: pwsh/cmd, Linux/macOS: sh/bash).";

  return [
    "TERMINAL COMMAND MODE",
    shellHint,
    "Execute exactly the command below in the terminal without rewriting it.",
    "If approval is required, request approval; otherwise run it immediately.",
    "After execution, return stdout/stderr and exit code.",
    `<command>${parsed.command}</command>`,
  ].join("\n");
}
