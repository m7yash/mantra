import * as vscode from 'vscode';
import { execSync } from 'child_process';

// ──────────────────────────────────────────────
//  Codex mode state
// ──────────────────────────────────────────────

/** Whether Codex mode is active — voice routes directly to Codex terminal. */
let _codexMode = false;

export function isCodexMode(): boolean { return _codexMode; }
export function setCodexMode(on: boolean): void {
  _codexMode = on;
  console.log(`[Mantra] Codex mode: ${on ? 'ON' : 'OFF'}`);
  vscode.window.setStatusBarMessage(on ? 'Codex mode ON — voice → Codex' : 'Codex mode OFF', 2000);
}

// Auto-exit Codex mode when user switches to a text editor
vscode.window.onDidChangeActiveTextEditor((editor) => {
  if (editor && _codexMode) {
    setCodexMode(false);
  }
});

// ──────────────────────────────────────────────
//  CLI installation check
// ──────────────────────────────────────────────

/**
 * Resolve a CLI binary using the user's login shell.
 *
 * The VS Code extension host process often has a stripped-down PATH that
 * doesn't include user-installed binaries (npm global, Homebrew, etc.).
 * By spawning the user's login shell (`$SHELL -lc`), we get the full
 * PATH from their .zshrc / .bashrc / .profile.
 */
export function resolveCliPath(binaryName: string): string | null {
  // On Windows, use `where` directly
  if (process.platform === 'win32') {
    try {
      return execSync(`where ${binaryName}`, {
        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split(/\r?\n/)[0] || null;
    } catch { return null; }
  }

  // macOS / Linux — use login shell so the full user PATH is available
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const result = execSync(`${shell} -lc "command -v ${binaryName}"`, {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Check if a CLI tool is installed. Returns true/false without UI popups.
 */
export function checkCliInstalled(name: string): boolean {
  const resolved = resolveCliPath(name);
  if (resolved) {
    console.log(`[Mantra] ${name} CLI found at: ${resolved}`);
    return true;
  }
  console.warn(`[Mantra] ${name} CLI not found`);
  return false;
}

// ──────────────────────────────────────────────
//  Terminal readiness detection
// ──────────────────────────────────────────────

/**
 * Wait until a terminal's shell integration activates (meaning the shell is
 * fully running and ready to accept commands).  Falls back to a conservative
 * timeout when shell integration isn't available.
 */
function waitForShellReady(terminal: vscode.Terminal, fallbackMs = 6000): Promise<void> {
  return new Promise<void>((resolve) => {
    // If shell integration is already active, we're done immediately
    if (terminal.shellIntegration) {
      resolve();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      disposable.dispose();
      clearTimeout(timer);
      resolve();
    };

    // Listen for shell integration to activate on this terminal
    const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === terminal) {
        console.log('[Mantra] Shell integration activated — terminal ready');
        finish();
      }
    });

    // Conservative fallback in case shell integration is not enabled
    const timer = setTimeout(() => {
      console.log('[Mantra] Shell integration timeout — proceeding with fallback');
      finish();
    }, fallbackMs);
  });
}

/**
 * Wait until a command starts executing in a terminal (via shell integration),
 * meaning the CLI has launched and is producing output.
 * Falls back to a conservative timeout.
 */
function waitForCommandStart(terminal: vscode.Terminal, fallbackMs = 6000): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      disposable.dispose();
      clearTimeout(timer);
      resolve();
    };

    const disposable = vscode.window.onDidStartTerminalShellExecution((e) => {
      if (e.terminal === terminal) {
        console.log('[Mantra] CLI command started executing — ready for input');
        finish();
      }
    });

    const timer = setTimeout(() => {
      console.log('[Mantra] Command start timeout — proceeding with fallback');
      finish();
    }, fallbackMs);
  });
}

// ──────────────────────────────────────────────
//  Codex terminal management
// ──────────────────────────────────────────────

let _codexTerminal: vscode.Terminal | null = null;
let _codexTerminalReady = false;

// Clear reference when terminal closes
vscode.window.onDidCloseTerminal((t) => {
  if (t === _codexTerminal) {
    _codexTerminal = null;
    _codexTerminalReady = false;
    if (_codexMode) setCodexMode(false);
    console.log('[Mantra] Codex terminal closed');
  }
});

/**
 * Check if the currently active terminal IS the Codex terminal.
 */
export function isCodexTerminalActive(): boolean {
  if (!_codexTerminal) return false;
  return vscode.window.activeTerminal === _codexTerminal;
}

/** Check if the given terminal is the Codex terminal. */
export function isCodexTerminal(t: vscode.Terminal): boolean {
  return !!_codexTerminal && t === _codexTerminal;
}

/**
 * Open (or re-focus) the Codex terminal.
 * Codex is a standalone CLI (no VS Code extension), so we create a
 * terminal and run the `codex` command in it.
 */
async function ensureCodexTerminal(): Promise<vscode.Terminal | null> {
  // If we already have a live, tracked Codex terminal, reuse it
  if (_codexTerminal) {
    const stillAlive = vscode.window.terminals.includes(_codexTerminal);
    if (stillAlive) {
      return _codexTerminal;
    }
    _codexTerminal = null;
    _codexTerminalReady = false;
  }

  // Check if codex CLI is installed (uses login shell for full PATH)
  if (!checkCliInstalled('codex')) {
    const pick = await vscode.window.showWarningMessage(
      'Codex is not installed.',
      'Install via npm',
      'Cancel'
    );
    if (pick === 'Install via npm') {
      const installTerminal = vscode.window.createTerminal({ name: 'Install Codex', isTransient: true });
      installTerminal.show(true);
      installTerminal.sendText('npm install -g @openai/codex', true);
    }
    return null;
  }

  // Create a new terminal and run codex.
  // The terminal shell inherits the user's full PATH, so `codex` will be found.
  const terminal = vscode.window.createTerminal({
    name: 'Codex',
    isTransient: true,
  });
  _codexTerminal = terminal;
  _codexTerminalReady = false;

  terminal.show(true);

  // Wait for the shell to be ready before sending the CLI command
  console.log('[Mantra] Waiting for shell to initialize...');
  vscode.window.setStatusBarMessage('Starting Codex...', 12000);
  await waitForShellReady(terminal, 8000);

  // Now launch codex and wait for it to actually start executing
  terminal.sendText('codex', true);
  await waitForCommandStart(terminal, 10000);

  // Brief extra settle time for the CLI to render its UI
  await sleep(500);
  _codexTerminalReady = true;
  console.log('[Mantra] Codex terminal ready');
  return _codexTerminal;
}

// ──────────────────────────────────────────────
//  Send to Codex
// ──────────────────────────────────────────────

/**
 * Send a prompt to Codex terminal and ensure it executes.
 */
export async function sendToCodexPanel(prompt: string): Promise<void> {
  const terminal = await ensureCodexTerminal();
  if (!terminal) {
    vscode.window.showWarningMessage('Could not open Codex terminal.');
    return;
  }

  terminal.show(true);

  if (!_codexTerminalReady) {
    // Terminal exists but wasn't fully ready — wait for shell integration
    // signal or conservative fallback
    await waitForCommandStart(terminal, 8000);
    _codexTerminalReady = true;
  }

  // Type the prompt without pressing Enter — user must confirm manually.
  terminal.sendText(prompt, false);
  setCodexMode(true);
  vscode.window.setStatusBarMessage('Typed in Codex (press Enter to send)', 3000);
  console.log(`[Mantra] Typed in Codex: ${prompt.slice(0, 80)}...`);
}

/**
 * Type text into the Codex terminal WITHOUT pressing Enter.
 */
export function typeInCodex(text: string): void {
  if (!_codexTerminal) {
    vscode.window.showWarningMessage('No Codex terminal available.');
    return;
  }
  _codexTerminal.sendText(text, false);
  vscode.window.setStatusBarMessage('Typed in Codex', 1500);
}

/**
 * Respond to a Codex prompt.
 */
export function respondToCodex(response: string): void {
  if (!_codexTerminal) {
    vscode.window.showWarningMessage('No active Codex terminal to respond to.');
    return;
  }
  _codexTerminal.sendText(response, true);
  vscode.window.setStatusBarMessage(`Codex ← ${response}`, 1500);
}

/**
 * Send Enter key to the Codex terminal (confirm current selection).
 */
export function confirmCodex(): void {
  if (!_codexTerminal) {
    vscode.window.showWarningMessage('No active Codex terminal.');
    return;
  }
  _codexTerminal.sendText('', true);
  vscode.window.setStatusBarMessage('Codex ← Enter', 1500);
}

/**
 * Send arrow key escape sequences to the Codex terminal.
 */
export function codexArrowUp(): void {
  if (!_codexTerminal) return;
  _codexTerminal.sendText('\x1b[A', false);
}

export function codexArrowDown(): void {
  if (!_codexTerminal) return;
  _codexTerminal.sendText('\x1b[B', false);
}

// ──────────────────────────────────────────────
//  Codex commands (voice-controlled)
// ──────────────────────────────────────────────

async function sendCodexCommand(cmd: string): Promise<void> {
  const terminal = _codexTerminal || await ensureCodexTerminal();
  if (!terminal) {
    vscode.window.showWarningMessage('Could not open Codex terminal.');
    return;
  }
  terminal.show(true);
  if (!_codexTerminalReady) {
    await waitForCommandStart(terminal, 8000);
    _codexTerminalReady = true;
  }
  terminal.sendText(cmd, true);
  setCodexMode(true);
  vscode.window.setStatusBarMessage(`Codex: ${cmd}`, 2000);
}

/** Send Escape (Ctrl+C) to interrupt Codex. */
export function codexInterrupt(): void {
  if (!_codexTerminal) {
    vscode.window.showWarningMessage('No Codex terminal.');
    return;
  }
  _codexTerminal.sendText('\x03', false);
  vscode.window.setStatusBarMessage('Codex interrupted', 1500);
}

// ──────────────────────────────────────────────
//  Focus & panel management
// ──────────────────────────────────────────────

/**
 * Focus the Codex terminal — opens one if needed.
 */
export async function focusCodexPanel(): Promise<void> {
  const terminal = await ensureCodexTerminal();
  if (terminal) {
    terminal.show();
    setCodexMode(true);
    return;
  }
  vscode.window.showWarningMessage('Could not open Codex.');
}

/**
 * Close the Codex terminal if it exists.
 */
export function closeCodexTerminal(): void {
  if (_codexTerminal) {
    _codexTerminal.dispose();
    _codexTerminal = null;
    _codexTerminalReady = false;
    if (_codexMode) setCodexMode(false);
    console.log('[Mantra] Codex terminal closed by request');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
