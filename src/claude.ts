import * as vscode from 'vscode';

// ──────────────────────────────────────────────
//  Claude mode state
// ──────────────────────────────────────────────

/** Whether Claude mode is active — voice routes directly to Claude terminal. */
let _claudeMode = false;

export function isClaudeMode(): boolean { return _claudeMode; }
export function setClaudeMode(on: boolean): void {
  _claudeMode = on;
  console.log(`[Mantra] Claude mode: ${on ? 'ON' : 'OFF'}`);
  vscode.window.setStatusBarMessage(on ? 'Claude mode ON — voice → Claude' : 'Claude mode OFF', 2000);
}

// Auto-exit Claude mode when user switches to a text editor
vscode.window.onDidChangeActiveTextEditor((editor) => {
  if (editor && _claudeMode) {
    setClaudeMode(false);
  }
});

// ──────────────────────────────────────────────
//  Terminal readiness detection
// ──────────────────────────────────────────────

/**
 * Wait until a terminal's shell integration activates or falls back to timeout.
 */
function waitForShellReady(terminal: vscode.Terminal, fallbackMs = 6000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (terminal.shellIntegration) { resolve(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; disposable.dispose(); clearTimeout(timer); resolve(); };
    const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === terminal) { console.log('[Mantra] Claude shell integration activated'); finish(); }
    });
    const timer = setTimeout(() => { console.log('[Mantra] Claude shell integration timeout — fallback'); finish(); }, fallbackMs);
  });
}

/**
 * Wait until a command starts executing in a terminal or falls back to timeout.
 */
function waitForCommandStart(terminal: vscode.Terminal, fallbackMs = 6000): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; disposable.dispose(); clearTimeout(timer); resolve(); };
    const disposable = vscode.window.onDidStartTerminalShellExecution((e) => {
      if (e.terminal === terminal) { console.log('[Mantra] Claude CLI started executing'); finish(); }
    });
    const timer = setTimeout(() => { console.log('[Mantra] Claude command start timeout — fallback'); finish(); }, fallbackMs);
  });
}

// ──────────────────────────────────────────────
//  Claude terminal management
// ──────────────────────────────────────────────

/**
 * We track the Claude terminal by reference, not name.
 * This avoids matching stale terminals or user-created terminals that happen
 * to contain "claude" in their name.
 */
let _claudeTerminal: vscode.Terminal | null = null;
let _claudeTerminalReady = false;

// Clear reference when terminal closes
vscode.window.onDidCloseTerminal((t) => {
  if (t === _claudeTerminal) {
    _claudeTerminal = null;
    _claudeTerminalReady = false;
    if (_claudeMode) setClaudeMode(false);
    console.log('[Mantra] Claude terminal closed');
  }
});

/**
 * Check if the currently active terminal IS the Claude terminal.
 */
export function isClaudeTerminalActive(): boolean {
  if (!_claudeTerminal) return false;
  return vscode.window.activeTerminal === _claudeTerminal;
}

/** Check if the given terminal is the Claude Code terminal. */
export function isClaudeTerminal(t: vscode.Terminal): boolean {
  return !!_claudeTerminal && t === _claudeTerminal;
}

/**
 * Open (or re-focus) the Claude Code terminal via the extension command.
 * Returns the terminal reference once it's created and initialized.
 *
 * Detection strategy:
 * 1. If we already have a tracked, live terminal reference → reuse it.
 * 2. Run claude-vscode.terminal.open and watch for a NEW terminal.
 * 3. If no new terminal appears, check if the extension focused an existing
 *    one that became the activeTerminal — adopt it if it looks like Claude.
 */
async function ensureClaudeTerminal(): Promise<vscode.Terminal | null> {
  // If we already have a live, tracked Claude terminal, reuse it
  if (_claudeTerminal) {
    const stillAlive = vscode.window.terminals.includes(_claudeTerminal);
    if (stillAlive) {
      return _claudeTerminal;
    }
    // Dead — clear it
    _claudeTerminal = null;
    _claudeTerminalReady = false;
  }

  // Snapshot current terminals before the open command
  const terminalsBefore = new Set(vscode.window.terminals);

  try {
    await vscode.commands.executeCommand('claude-vscode.terminal.open');
  } catch (err) {
    console.warn('[Mantra] claude-vscode.terminal.open failed:', err);
    vscode.window.showWarningMessage(
      'Claude Code terminal could not be opened. Make sure the Claude Code extension is installed.'
    );
    return null;
  }

  // Wait for a NEW terminal to appear (the one the extension just created)
  for (let i = 0; i < 15; i++) {
    await sleep(300);
    const newTerminal = vscode.window.terminals.find(t => !terminalsBefore.has(t));
    if (newTerminal) {
      _claudeTerminal = newTerminal;
      _claudeTerminalReady = false;
      console.log(`[Mantra] Claude terminal created: "${newTerminal.name}"`);

      // Wait for the CLI to actually start executing.
      // Shell integration fires onDidStartTerminalShellExecution when the
      // `claude` process launches, so we know it's accepting input.
      // Falls back to a conservative timeout if shell integration isn't active.
      console.log('[Mantra] Waiting for Claude CLI to initialize...');
      vscode.window.setStatusBarMessage('Starting Claude...', 12000);
      await waitForCommandStart(newTerminal, 10000);
      await sleep(500); // brief settle for the CLI to render its UI
      _claudeTerminalReady = true;
      console.log('[Mantra] Claude terminal ready');
      return _claudeTerminal;
    }
  }

  // No new terminal appeared — the extension may have focused an existing one.
  // Adopt it if the active terminal looks like Claude (name set by the extension).
  await sleep(500);
  const active = vscode.window.activeTerminal;
  if (active && /claude/i.test(active.name)) {
    console.log(`[Mantra] Adopting existing Claude terminal: "${active.name}"`);
    _claudeTerminal = active;
    _claudeTerminalReady = true; // assume it's already initialized since it existed
    return _claudeTerminal;
  }

  console.warn('[Mantra] claude-vscode.terminal.open did not create or focus a Claude terminal');
  vscode.window.showWarningMessage(
    'Claude terminal may not be running. Try closing old Claude terminals and saying "open claude" again.'
  );
  return null;
}

// ──────────────────────────────────────────────
//  Send to Claude
// ──────────────────────────────────────────────

/**
 * Send a prompt to Claude Code terminal and ensure it executes.
 */
export async function sendToClaudePanel(prompt: string): Promise<void> {
  const wasReady = _claudeTerminalReady;
  const terminal = await ensureClaudeTerminal();
  if (!terminal) {
    vscode.window.showWarningMessage('Could not open Claude Code terminal.');
    return;
  }

  if (!_claudeTerminalReady) {
    terminal.show(true);
    await waitForCommandStart(terminal, 8000);
    _claudeTerminalReady = true;
  }

  // Extra settle time when the terminal was just opened — Claude's CLI
  // needs a moment after initialization before its input handler is ready.
  if (!wasReady) {
    await sleep(1500);
  }

  terminal.sendText(prompt, false); // type without pressing Enter
  setClaudeMode(true);
  vscode.window.setStatusBarMessage('Typed in Claude (press Enter to send)', 3000);
  console.log(`[Mantra] Typed in Claude: ${prompt.slice(0, 80)}...`);
}

/**
 * Type text into the Claude terminal WITHOUT pressing Enter.
 * Used for passthrough: user's words appear in Claude's input,
 * then user says "enter" to submit.
 */
export function typeInClaude(text: string): void {
  if (!_claudeTerminal) {
    vscode.window.showWarningMessage('No Claude terminal available.');
    return;
  }
  _claudeTerminal.sendText(text, false); // false = no newline
  vscode.window.setStatusBarMessage('Typed in Claude', 1500);
}

/**
 * Respond to a Claude CLI prompt.
 * Claude CLI uses an interactive selection UI — responses are typically
 * just pressing Enter (to confirm the highlighted option) or arrow keys
 * to navigate. For y/n prompts, sends the character.
 */
export function respondToClaude(response: string): void {
  if (!_claudeTerminal) {
    vscode.window.showWarningMessage('No active Claude terminal to respond to.');
    return;
  }
  _claudeTerminal.sendText(response, true);
  vscode.window.setStatusBarMessage(`Claude ← ${response}`, 1500);
}

/**
 * Send Enter key to the Claude terminal (confirm current selection).
 * This is the primary way to interact with Claude CLI permission prompts,
 * which use an arrow-key selection UI where Enter confirms.
 */
export function confirmClaude(): void {
  if (!_claudeTerminal) {
    vscode.window.showWarningMessage('No active Claude terminal.');
    return;
  }
  // Send empty string with addNewLine=true → just presses Enter
  _claudeTerminal.sendText('', true);
  vscode.window.setStatusBarMessage('Claude ← Enter', 1500);
}

/**
 * Send arrow key escape sequences to the Claude terminal.
 * Used to navigate Claude CLI selection menus.
 */
export function claudeArrowUp(): void {
  if (!_claudeTerminal) return;
  // ANSI escape for up arrow
  _claudeTerminal.sendText('\x1b[A', false);
}

export function claudeArrowDown(): void {
  if (!_claudeTerminal) return;
  // ANSI escape for down arrow
  _claudeTerminal.sendText('\x1b[B', false);
}

// ──────────────────────────────────────────────
//  Claude CLI commands (voice-controlled)
// ──────────────────────────────────────────────

/**
 * Send a Claude CLI slash command to the active Claude terminal.
 * If no terminal exists, opens one first.
 */
async function sendClaudeCommand(cmd: string): Promise<void> {
  const terminal = _claudeTerminal || await ensureClaudeTerminal();
  if (!terminal) {
    vscode.window.showWarningMessage('Could not open Claude terminal.');
    return;
  }
  terminal.show(true);
  if (!_claudeTerminalReady) {
    await waitForCommandStart(terminal, 8000);
    _claudeTerminalReady = true;
  }
  terminal.sendText(cmd, true);
  setClaudeMode(true);
  vscode.window.setStatusBarMessage(`Claude: ${cmd}`, 2000);
}

/** Resume the last Claude conversation. */
export async function claudeResume(): Promise<void> {
  await sendClaudeCommand('/resume');
}

/** Start a new Claude conversation. */
export async function claudeNewConversation(): Promise<void> {
  await sendClaudeCommand('/clear');
}

/** Set the Claude model. */
export async function claudeSetModel(model: string): Promise<void> {
  await sendClaudeCommand(`/model ${model}`);
}

/** Show Claude help. */
export async function claudeHelp(): Promise<void> {
  await sendClaudeCommand('/help');
}

/** Show Claude status/config. */
export async function claudeStatus(): Promise<void> {
  await sendClaudeCommand('/status');
}

/** Compact/summarize Claude conversation. */
export async function claudeCompact(): Promise<void> {
  await sendClaudeCommand('/compact');
}

/** Undo the last Claude action. */
export async function claudeUndo(): Promise<void> {
  await sendClaudeCommand('/undo');
}

/** Send Escape (Ctrl+C) to interrupt Claude. */
export function claudeInterrupt(): void {
  if (!_claudeTerminal) {
    vscode.window.showWarningMessage('No Claude terminal.');
    return;
  }
  // Send Ctrl+C via special escape sequence
  _claudeTerminal.sendText('\x03', false);
  vscode.window.setStatusBarMessage('Claude interrupted', 1500);
}

// ──────────────────────────────────────────────
//  Focus & panel management
// ──────────────────────────────────────────────

/**
 * Focus the Claude Code terminal — opens one if needed.
 */
export async function focusClaudePanel(): Promise<void> {
  const terminal = await ensureClaudeTerminal();
  if (terminal) {
    terminal.show();
    setClaudeMode(true);
    return;
  }
  vscode.window.showWarningMessage('Could not open Claude Code.');
}

/**
 * Accept proposed changes from Claude Code.
 */
export async function acceptClaudeChanges(): Promise<void> {
  try {
    await vscode.commands.executeCommand('claude-vscode.acceptProposedDiff');
    vscode.window.setStatusBarMessage('Accepted Claude changes', 1500);
  } catch {
    // Also try responding 'y' in terminal
    respondToClaude('y');
  }
}

/**
 * Reject proposed changes from Claude Code.
 */
export async function rejectClaudeChanges(): Promise<void> {
  try {
    await vscode.commands.executeCommand('claude-vscode.rejectProposedDiff');
    vscode.window.setStatusBarMessage('Rejected Claude changes', 1500);
  } catch {
    respondToClaude('n');
  }
}

/**
 * Close the Claude terminal if it exists.
 */
export function closeClaudeTerminal(): void {
  if (_claudeTerminal) {
    _claudeTerminal.dispose();
    _claudeTerminal = null;
    _claudeTerminalReady = false;
    if (_claudeMode) setClaudeMode(false);
    console.log('[Mantra] Claude terminal closed by request');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
