import * as vscode from 'vscode';

/**
 * Find an existing VS Code terminal that is running Claude Code.
 * Returns null if none found.
 */
function findClaudeTerminal(): vscode.Terminal | null {
  for (const t of vscode.window.terminals) {
    if (/claude/i.test(t.name)) return t;
  }
  return null;
}

/**
 * Send a prompt to Claude Code.
 *
 * Strategy:
 * 1. If there's already a terminal with "claude" in its name, type directly into it (reliable).
 * 2. Otherwise, use the sidebar panel via clipboard + paste (best-effort for webview).
 */
export async function sendToClaudePanel(prompt: string): Promise<void> {
  // --- Path A: existing Claude terminal (most reliable) ---
  const claudeTerminal = findClaudeTerminal();
  if (claudeTerminal) {
    claudeTerminal.show(true);
    await sleep(100);
    claudeTerminal.sendText(prompt, true);
    vscode.window.setStatusBarMessage('Sent to Claude terminal', 2000);
    return;
  }

  // --- Path B: sidebar panel via clipboard ---
  const savedClipboard = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(prompt);

  try {
    await vscode.commands.executeCommand('claude-vscode.sidebar.open');
    await sleep(300);
    await vscode.commands.executeCommand('claude-vscode.focus');
    await sleep(200);

    // Paste from clipboard into the focused webview input
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await sleep(100);

    // Submit
    await vscode.commands.executeCommand('type', { text: '\n' });
    vscode.window.setStatusBarMessage('Sent to Claude Code', 2000);
  } catch {
    // Fallback: panel is open, prompt is on clipboard
    vscode.window.showInformationMessage('Prompt copied to clipboard — paste into Claude with Cmd+V');
    return;  // keep prompt on clipboard
  }

  // Restore original clipboard
  await sleep(500);
  await vscode.env.clipboard.writeText(savedClipboard);
}

/**
 * Focus the Claude Code panel — tries terminal first, then sidebar.
 */
export async function focusClaudePanel(): Promise<void> {
  const claudeTerminal = findClaudeTerminal();
  if (claudeTerminal) {
    claudeTerminal.show();
    return;
  }
  try {
    await vscode.commands.executeCommand('claude-vscode.sidebar.open');
    await vscode.commands.executeCommand('claude-vscode.focus');
  } catch {
    vscode.window.showWarningMessage('Could not focus Claude Code. Is the extension installed?');
  }
}

/**
 * Start a new Claude Code conversation.
 */
export async function newClaudeConversation(): Promise<void> {
  try {
    await vscode.commands.executeCommand('claude-vscode.newConversation');
  } catch {
    vscode.window.showWarningMessage('Claude Code new conversation command not available.');
  }
}

/**
 * Accept proposed changes from Claude Code.
 */
export async function acceptClaudeChanges(): Promise<void> {
  await vscode.commands.executeCommand('claude-vscode.acceptProposedDiff');
  vscode.window.setStatusBarMessage('Accepted Claude changes', 1500);
}

/**
 * Reject proposed changes from Claude Code.
 */
export async function rejectClaudeChanges(): Promise<void> {
  await vscode.commands.executeCommand('claude-vscode.rejectProposedDiff');
  vscode.window.setStatusBarMessage('Rejected Claude changes', 1500);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
