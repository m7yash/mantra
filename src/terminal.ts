import * as vscode from 'vscode';

/**
 * Get or create a terminal to use.
 * If an active terminal exists, use it; otherwise create a new one.
 */
function getOrCreateTerminal(): vscode.Terminal {
  const active = vscode.window.activeTerminal;
  if (active) return active;
  const terminals = vscode.window.terminals;
  if (terminals.length > 0) return terminals[terminals.length - 1];
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
  terminal.show(true);
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
