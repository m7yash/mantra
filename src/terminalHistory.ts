import * as vscode from 'vscode';

export interface TerminalEntry {
  command: string;
  output: string;
  exitCode: number | undefined;
  timestamp: number;
}

const history: TerminalEntry[] = [];
const MAX_ENTRIES = 50;
const pendingOutputs = new Map<vscode.TerminalShellExecution, Promise<string>>();

/**
 * Start tracking terminal command executions via VS Code shell integration.
 * Captures all commands + output for the session.
 */
export function initTerminalHistory(): vscode.Disposable[] {
  const d1 = vscode.window.onDidStartTerminalShellExecution((e) => {
    const outputPromise = (async () => {
      let output = '';
      try {
        for await (const chunk of e.execution.read()) {
          output += chunk;
          if (output.length > 15000) {
            output = '...(earlier output truncated)\n' + output.slice(-12000);
          }
        }
      } catch { /* stream may error if terminal closes */ }
      return output;
    })();
    pendingOutputs.set(e.execution, outputPromise);
  });

  const d2 = vscode.window.onDidEndTerminalShellExecution(async (e) => {
    const outputPromise = pendingOutputs.get(e.execution);
    pendingOutputs.delete(e.execution);
    const output = outputPromise ? await outputPromise : '';

    const entry: TerminalEntry = {
      command: e.execution.commandLine.value,
      output: output.trim(),
      exitCode: e.exitCode,
      timestamp: Date.now(),
    };
    history.push(entry);
    if (history.length > MAX_ENTRIES) history.shift();
    console.log(`[Mantra] Terminal command finished: "${entry.command}" (exit: ${entry.exitCode ?? '?'})`);
  });

  return [d1, d2];
}

/**
 * Get the last terminal command + output, if recent enough.
 */
export function getLastTerminalOutput(maxAgeMs = 5 * 60 * 1000): TerminalEntry | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (Date.now() - last.timestamp > maxAgeMs) return null;
  return last;
}

/**
 * Get the full terminal history for the session.
 * Returns entries formatted as a string, capped to maxChars to keep prompts manageable.
 */
export function getFullTerminalHistory(maxChars = 8000): string {
  if (history.length === 0) return '';

  const parts: string[] = [];
  // Build from newest to oldest, then reverse, so we keep the most recent if we hit the cap
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    const lines: string[] = [];
    lines.push(`$ ${e.command}`);
    if (e.exitCode !== undefined && e.exitCode !== 0) {
      lines.push(`[exit code: ${e.exitCode}]`);
    }
    if (e.output) {
      // Cap individual entry output
      const out = e.output.length > 2000
        ? e.output.slice(0, 500) + '\n...(truncated)...\n' + e.output.slice(-1000)
        : e.output;
      lines.push(out);
    }
    const block = lines.join('\n');

    // Check if adding this block would exceed the cap
    const currentLen = parts.reduce((s, p) => s + p.length + 1, 0);
    if (currentLen + block.length > maxChars && parts.length > 0) break;
    parts.push(block);
  }

  parts.reverse();
  return parts.join('\n\n');
}

/**
 * Format the last terminal entry as context for Claude.
 */
export function formatTerminalContext(entry: TerminalEntry): string {
  const parts: string[] = [];
  parts.push(`Last terminal command: ${entry.command}`);
  if (entry.exitCode !== undefined && entry.exitCode !== 0) {
    parts.push(`Exit code: ${entry.exitCode}`);
  }
  if (entry.output) {
    parts.push('Output:');
    parts.push(entry.output);
  }
  return parts.join('\n');
}
