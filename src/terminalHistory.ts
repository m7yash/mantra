import * as vscode from 'vscode';

export interface TerminalEntry {
  command: string;
  output: string;
  exitCode: number | undefined;
  timestamp: number;
}

let lastEntry: TerminalEntry | null = null;
const pendingOutputs = new Map<vscode.TerminalShellExecution, Promise<string>>();

/**
 * Start tracking terminal command executions via VS Code shell integration.
 * Captures the last command + output so it can be forwarded to Claude.
 */
export function initTerminalHistory(): vscode.Disposable[] {
  const d1 = vscode.window.onDidStartTerminalShellExecution((e) => {
    // Start reading output immediately — the async iterable completes when the command finishes
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

    lastEntry = {
      command: e.execution.commandLine.value,
      output: output.trim(),
      exitCode: e.exitCode,
      timestamp: Date.now(),
    };
    console.log(`[Mantra] Terminal command finished: "${lastEntry.command}" (exit: ${lastEntry.exitCode ?? '?'})`);
  });

  return [d1, d2];
}

/**
 * Get the last terminal command + output, if recent enough.
 * Returns null if there's no history or it's older than maxAgeMs (default 5 minutes).
 */
export function getLastTerminalOutput(maxAgeMs = 5 * 60 * 1000): TerminalEntry | null {
  if (!lastEntry) return null;
  if (Date.now() - lastEntry.timestamp > maxAgeMs) return null;
  return lastEntry;
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
