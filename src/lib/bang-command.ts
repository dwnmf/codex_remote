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

function normalizeShell(raw: string): TerminalShell | null {
  const trimmed = raw.trim().toLowerCase();
  return SHELL_ALIASES[trimmed] ?? null;
}

export function parseBangTerminalCommand(input: string): BangTerminalCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("!")) return null;

  const rest = trimmed.slice(1).trim();
  if (!rest) return { shell: null, command: "" };

  const firstWhitespace = rest.search(/\s/);
  if (firstWhitespace < 0) {
    const shell = normalizeShell(rest);
    if (shell) return { shell, command: "" };
    return { shell: null, command: rest };
  }

  const token = rest.slice(0, firstWhitespace).replace(/:$/, "");
  const shell = normalizeShell(token);
  if (!shell) {
    return { shell: null, command: rest };
  }

  return {
    shell,
    command: rest.slice(firstWhitespace).trim(),
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
