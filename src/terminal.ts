import * as vscode from 'vscode';
import { isClaudeTerminal } from './claude';

/**
 * Get or create a terminal to use.
 * Skips the Claude Code agent terminal — that's for the AI agent, not user commands.
 */
function getOrCreateTerminal(): vscode.Terminal {
  // Prefer the active terminal if it's not the agent terminal
  const active = vscode.window.activeTerminal;
  if (active && !isClaudeTerminal(active)) return active;

  // Otherwise find any non-agent terminal
  const terminals = vscode.window.terminals;
  for (let i = terminals.length - 1; i >= 0; i--) {
    if (!isClaudeTerminal(terminals[i])) {
      return terminals[i];
    }
  }

  // No suitable terminal found — create one
  return vscode.window.createTerminal('Mantra Terminal');
}

/**
 * Type a command into the terminal WITHOUT executing it (no Enter key).
 * The terminal is shown so the user can review the command.
 */
export function typeInTerminal(command: string): void {
  const terminal = getOrCreateTerminal();
  terminal.show(true); // preserve focus = true
  terminal.sendText(command, false); // false = don't add newline
  vscode.window.setStatusBarMessage(`Typed: ${command}`, 3000);
}

/**
 * Type a command into the terminal AND execute it (sends Enter).
 */
export function executeInTerminal(command: string): void {
  const terminal = getOrCreateTerminal();
  terminal.show(false); // false = focus the terminal so user sees it
  terminal.sendText(command, true); // true = add newline (execute)
  vscode.window.setStatusBarMessage(`Executing: ${command}`, 3000);
}

/**
 * Send Enter to the active terminal — executes whatever was previously typed.
 */
export function executeLastTyped(): boolean {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showWarningMessage('No active terminal to execute in.');
    return false;
  }
  terminal.sendText('', true); // empty string + newline = Enter
  vscode.window.setStatusBarMessage('Executed (Enter)', 1500);
  return true;
}