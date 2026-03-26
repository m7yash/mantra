import * as vscode from 'vscode';
import { startMicStream, pauseRecording, recorderActive, onVolume, offVolume, getMicName, testMic, stopMicTest, isMicTesting } from './recorder';
import { Model } from './model';
import { canonicalCommandPhrases, tryExecuteMappedCommand } from './commands';
import { handleCommand as handleTextCommand } from './textOps';
import { typeInTerminal, executeInTerminal, executeLastTyped } from './terminal';
import {
  sendToClaudePanel, confirmClaude, typeInClaude,
  claudeArrowUp, claudeArrowDown,
  focusClaudePanel, acceptClaudeChanges, rejectClaudeChanges,
  isClaudeMode, setClaudeMode, isClaudeTerminalActive,
  claudeResume, claudeNewConversation, claudeSetModel,
  claudeHelp, claudeStatus, claudeCompact, claudeUndo, claudeInterrupt,
  closeClaudeTerminal,
} from './claude';
import {
  sendToCodexPanel, confirmCodex, typeInCodex,
  codexArrowUp, codexArrowDown,
  focusCodexPanel,
  isCodexMode, setCodexMode, isCodexTerminalActive,
  codexInterrupt,
  closeCodexTerminal, checkCliInstalled,
} from './codex';
import { MantraSidebarProvider, LogEntry } from './sidebarProvider';
import { exec } from 'child_process';
import { initTerminalHistory, getLastTerminalOutput, getFullTerminalHistory, formatTerminalContext } from './terminalHistory';
import ffmpegStatic from 'ffmpeg-static';
import { spawnSync } from 'child_process';

let model: Model | null = null;
let cerebrasApiKey: string = '';
let groqApiKey: string = '';
let deepgramApiKey: string = '';
let outputChannel: vscode.OutputChannel | null = null;
let sidebar: MantraSidebarProvider | null = null;

// Track explicit pause state separate from recorder process state
let __mantraPaused = false;
// Guard against double-entry into the listening loop
let __mantraSessionActive = false;

/** Push a log entry to the sidebar activity log. */
function pushLog(kind: LogEntry['kind'], text: string, diff?: string): void {
  if (!sidebar) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  sidebar.pushLog({ time, kind, text, diff });
}

/** Get the currently selected agent backend from settings. */
function getSelectedAgent(): 'claude' | 'codex' {
  return vscode.workspace.getConfiguration('mantra').get<string>('agentBackend', 'claude') as 'claude' | 'codex';
}

/** Check if the selected agent's mode or terminal is active (voice should go to agent). */
function isAgentModeActive(): boolean {
  const agent = getSelectedAgent();
  if (agent === 'claude') return isClaudeMode() || isClaudeTerminalActive();
  return isCodexMode() || isCodexTerminalActive();
}

/** Focus the selected agent's panel. */
async function focusSelectedAgent(): Promise<void> {
  const agent = getSelectedAgent();
  if (agent === 'claude') {
    // Close codex terminal to enforce mutual exclusivity
    closeCodexTerminal();
    await focusClaudePanel();
  } else {
    closeClaudeTerminal();
    await focusCodexPanel();
  }
}

/** Send a prompt to the selected agent. */
async function sendToSelectedAgent(prompt: string): Promise<void> {
  const agent = getSelectedAgent();
  if (agent === 'claude') {
    await sendToClaudePanel(prompt);
  } else {
    await sendToCodexPanel(prompt);
  }
}

/** Type text into the selected agent's terminal (no Enter). */
function typeInSelectedAgent(text: string): void {
  const agent = getSelectedAgent();
  if (agent === 'claude') {
    typeInClaude(text);
  } else {
    typeInCodex(text);
  }
}

/** Confirm (Enter) in the selected agent's terminal. */
function confirmSelectedAgent(): void {
  const agent = getSelectedAgent();
  if (agent === 'claude') {
    confirmClaude();
  } else {
    confirmCodex();
  }
}

/** Arrow up in the selected agent's terminal. */
function agentArrowUp(): void {
  const agent = getSelectedAgent();
  if (agent === 'claude') claudeArrowUp();
  else codexArrowUp();
}

/** Arrow down in the selected agent's terminal. */
function agentArrowDown(): void {
  const agent = getSelectedAgent();
  if (agent === 'claude') claudeArrowDown();
  else codexArrowDown();
}

/** Interrupt the selected agent. */
function interruptSelectedAgent(): void {
  const agent = getSelectedAgent();
  if (agent === 'claude') claudeInterrupt();
  else codexInterrupt();
}

/** Check if the selected agent CLI is installed. */
function isSelectedAgentInstalled(): boolean {
  const agent = getSelectedAgent();
  if (agent === 'claude') {
    // Claude can use the VS Code extension command; check for CLI too
    return true; // Claude is opened via VS Code extension, always "available"
  }
  return checkCliInstalled('codex');
}

/** Produce a compact unified-style diff between two texts (line-based). */
function makeUnifiedDiff(oldText: string, newText: string, filename: string): string {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  // Simple LCS-based diff
  const n = oldLines.length, m = newLines.length;
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  const idx = (i: number, j: number) => i * W + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[idx(i, j)] = oldLines[i] === newLines[j]
        ? dp[idx(i + 1, j + 1)] + 1
        : Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)]);
    }
  }

  // Walk to collect hunks
  const ops: Array<{ type: '=' | '+' | '-'; line: string; oldIdx: number; newIdx: number }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: '=', line: oldLines[i], oldIdx: i, newIdx: j });
      i++; j++;
    } else if (dp[idx(i + 1, j)] >= dp[idx(i, j + 1)]) {
      ops.push({ type: '-', line: oldLines[i], oldIdx: i, newIdx: j });
      i++;
    } else {
      ops.push({ type: '+', line: newLines[j], oldIdx: i, newIdx: j });
      j++;
    }
  }
  while (i < n) { ops.push({ type: '-', line: oldLines[i], oldIdx: i, newIdx: m }); i++; }
  while (j < m) { ops.push({ type: '+', line: newLines[j], oldIdx: n, newIdx: j }); j++; }

  // Group into hunks with 2 lines of context
  const CTX = 2;
  const hunks: string[] = [];
  let hi = 0;
  while (hi < ops.length) {
    if (ops[hi].type === '=') { hi++; continue; }
    // Found a change — expand context around it
    const start = Math.max(0, hi - CTX);
    let end = hi;
    while (end < ops.length) {
      if (ops[end].type !== '=') { end++; continue; }
      // Check if next change is within context distance
      let peek = end;
      while (peek < ops.length && ops[peek].type === '=' && peek - end < CTX * 2) peek++;
      if (peek < ops.length && ops[peek].type !== '=') { end = peek; continue; }
      break;
    }
    end = Math.min(ops.length, end + CTX);

    const oldStart = ops[start].oldIdx + 1;
    const newStart = ops[start].newIdx + 1;
    let oldCount = 0, newCount = 0;
    const lines: string[] = [];
    for (let k = start; k < end; k++) {
      if (ops[k].type === '=') { lines.push(' ' + ops[k].line); oldCount++; newCount++; }
      else if (ops[k].type === '-') { lines.push('-' + ops[k].line); oldCount++; }
      else { lines.push('+' + ops[k].line); newCount++; }
    }
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join('\n')}`);
    hi = end;
  }

  if (!hunks.length) return '';
  return `--- ${filename}\n+++ ${filename}\n${hunks.join('\n')}`;
}

/** If the prompt references terminal output/errors, save terminal history to a temp file and reference it. */
const TERMINAL_CONTEXT_RE = /\b(error|fix|debug|wrong|fail|broke|broken|crash|issue|bug|output|terminal|what happened|went wrong|doesn't work|not working|won't run)\b/i;

function buildClaudePrompt(prompt: string): string {
  const history = getFullTerminalHistory();
  if (!history) return prompt;
  const lastEntry = getLastTerminalOutput();
  // Include terminal reference if prompt references errors/output OR last command failed
  if (TERMINAL_CONTEXT_RE.test(prompt) || (lastEntry && lastEntry.exitCode !== undefined && lastEntry.exitCode !== 0)) {
    try {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const tmpFile = path.join(os.tmpdir(), 'mantra-terminal-history.txt');
      fs.writeFileSync(tmpFile, history, 'utf8');
      return prompt + `\n\nSee terminal history at: ${tmpFile}`;
    } catch {
      // If file write fails, just mention the terminal context briefly
      const last = lastEntry;
      return prompt + (last ? `\n\nLast command: ${last.command}` + (last.exitCode ? ` (exit ${last.exitCode})` : '') : '');
    }
  }
  return prompt;
}

function syncFromSettings() {
  const cfg = vscode.workspace.getConfiguration('mantra');
  const cerebras = (cfg.get<string>('cerebrasApiKey') || '').trim();
  const groq = (cfg.get<string>('groqApiKey') || '').trim();
  const deep = (cfg.get<string>('deepgramApiKey') || '').trim();
  const effort = (cfg.get<string>('reasoningEffort') || 'low').trim();
  const provider = (cfg.get<string>('llmProvider') || 'groq').trim();
  const groqModel = (cfg.get<string>('groqModel') || 'openai/gpt-oss-20b').trim();

  if (cerebras) process.env.CEREBRAS_API_KEY = cerebras;
  if (groq) process.env.GROQ_API_KEY = groq;
  if (deep) process.env.DEEPGRAM_API_KEY = deep;
  process.env.MANTRA_REASONING_EFFORT = effort;

  if (model) {
    model.setProvider(provider as any);
    if (groq) model.setGroqApiKey(groq);
    model.setGroqModel(groqModel);
  }
}

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  // .env & dotenv-style files
  /(\/|^)\.env(\.[^\/\\]+)?$/i,
  /(\/|^)\.envrc$/i,
  /(\/|^)\.dotenv(\.[^\/\\]+)?$/i,

  // generic secrets/credentials (secrets, credentials, creds, with any ext)
  /(\/|^)(secrets?|credentials?|creds?)(\.[^\/\\]+)?$/i,

  // Cloud/CLI creds & common SDK keys
  /(\/|^)\.aws\/(credentials|config)$/i,
  /(\/|^)\.kube\/config$/i,
  /(\/|^)kube-?config(\.[^\/\\]+)?$/i,
  /(\/|^)\.gcloud\/application_default_credentials\.json$/i,
  /(\/|^)(service[-_. ]?account|gcp[-_. ]?key|firebase[-_. ]?adminsdk)[^\/\\]*\.json$/i,
  /(\/|^)credentials\.json$/i,
  /(\/|^)auth\.json$/i,

  // Package/tooling auth
  /(\/|^)\.npmrc$/i,
  /(\/|^)\.pypirc$/i,
  /(\/|^)\.netrc$/i,
  /(\/|^)\.docker\/config\.json$/i,

  // SSH keys (inside or outside ~/.ssh)
  /(\/|^)\.ssh\/id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(\/|^)id_(rsa|dsa|ecdsa|ed25519)$/i,

  // Private keys & cert stores
  /\.(pem|key|p12|pfx|p7b|p7c|p8|pk8|der|crt|cer|jks|keystore)$/i,

  // Terraform state (can include secrets)
  /(\/|^)\.terraform(\/|$)/i,
  /\.tfstate(\.backup)?$/i,

  // Vault files
  /(\/|^)vault(\.[^\/\\]+)?$/i,
];

// Content-based secret scanning
type SecretHit = { name: string; line: number; col: number; preview: string };
const SENSITIVE_CONTENT_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'OpenAI API key', regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g },
  { name: 'Slack token', regex: /\bxox[baprs]-\d{10,}-\d{10,}-[A-Za-z0-9-]{24,}\b/g },
  { name: 'Stripe secret key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'SendGrid API key', regex: /\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: 'AWS Access Key ID', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'AWS Secret Access Key', regex: /\b(?:(?:aws_)?secret(?:_access)?_key)\b\s*[:=]\s*['"]?[A-Za-z0-9\/+=]{40}['"]?/gi },
  { name: 'Twilio Account SID', regex: /\bAC[a-f0-9]{32}\b/g },
  { name: 'Twilio Auth Token', regex: /\b(?:(?:twilio_)?auth[_-]?token)\b\s*[:=]\s*['"]?[a-f0-9]{32}['"]?/gi },
  { name: 'Deepgram API key', regex: /\bdg-[A-Za-z0-9]{40}\b/g },
  { name: 'PEM private key block', regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP|PRIVATE) KEY-----[\s\S]*?-----END (?:RSA|EC|DSA|OPENSSH|PGP|PRIVATE) KEY-----/g },
  { name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'MongoDB URI with credentials', regex: /\bmongodb(?:\+srv)?:\/\/[^@\s:]+:[^@\s]+@/gi },
  { name: 'SQL URI with credentials', regex: /\b(?:postgres|mysql|mariadb|sqlserver):\/\/[^@\s:]+:[^@\s]+@/gi },
];
const SECRETISH_KV_RX = /\b(api|app|client|access|private|secret|auth|bearer|jwt|token|pwd|password|pass|key|credential|credentials)[-_ ]*(?:id|key|token|secret)?\b\s*[:=]\s*['"]?([A-Za-z0-9_\-\/+=]{1,})['"]?/gi;
const SENSITIVE_NAME_TOKENS = new Set(['api', 'key', 'secret', 'token', 'password', 'passwd', 'pwd', 'auth', 'credential', 'credentials', 'jwt', 'bearer']);
function splitTokens(id: string): string[] {
  const parts = id.split(/[_-]+/).flatMap(p => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/));
  return parts.map(s => s.toLowerCase()).filter(Boolean);
}
const ASSIGN_RX = /\b([A-Za-z_][A-Za-z0-9_]*)\b\s*(?::|=)\s*/g;
function redact(sample: string): string {
  const s = (sample || '').trim();
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}…${s.slice(-2)}`;
}
function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  const len = s.length;
  let H = 0;
  for (const k in freq) {
    const p = freq[k] / len;
    H -= p * Math.log2(p);
  }
  return H;
}

function scanActiveEditorForSensitiveContent(): SecretHit[] {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return [];
  const doc = ed.document;
  const full = doc.getText();

  const hits: SecretHit[] = [];
  const pushHit = (name: string, index: number) => {
    const pos = doc.positionAt(index);
    const lineText = doc.lineAt(pos.line).text;
    hits.push({
      name,
      line: pos.line + 1,
      col: pos.character + 1,
      preview: lineText.replace(/['"]?([A-Za-z0-9_\-\/+=]{3,})['"]?/g, (m) => redact(m)),
    });
  };

  // 1) Targeted vendor/format patterns (JWT/PEM/URIs with creds/etc.)
  for (const { name, regex } of SENSITIVE_CONTENT_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(full))) {
      pushHit(name, m.index);
      if (regex.lastIndex === m.index) regex.lastIndex++; // avoid zero-width loops
      if (hits.length >= 50) return hits;
    }
  }

  const lineCount = Math.min(doc.lineCount, 50000);

  // 2) Secret-ish key/value on a line (by name) — only flag if literal/URI or high-entropy.
  for (let i = 0; i < lineCount; i++) {
    const line = doc.lineAt(i).text;
    SECRETISH_KV_RX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SECRETISH_KV_RX.exec(line))) {
      const val = m[2] || '';
      // Allow usages sourced from env/secret stores (mentions, not inline secrets)
      if (/(process\.env|import\.meta\.env|Deno\.env\.get\(|Bun\.env|context\.secrets\.get\(|secrets\.get\()/i.test(line.slice(m.index))) {
        continue;
      }

      const rhs2 = line.slice(m.index);
      const isRhsString = /[:=]\s*['"`]/.test(rhs2);
      const rhsHasUriCreds = /[:=][^#\n]*:\/\/[^@\s:]+:[^@\s]+@/i.test(rhs2);
      const looksRandom = /[A-Za-z]/.test(val) && /\d/.test(val) && shannonEntropy(val) >= 4.0;

      if (!(looksRandom || isRhsString || rhsHasUriCreds)) continue;

      hits.push({
        name: looksRandom
          ? 'High-entropy secret-like value'
          : (rhsHasUriCreds ? 'Connection string with credentials' : 'Secret-like assignment'),
        line: i + 1,
        col: m.index + 1,
        preview: line.replace(val, redact(val)),
      });
      if (hits.length >= 50) return hits;
    }
  }

  // 3) Sensitive variable name — only flag if RHS is a literal or URI containing creds.
  for (let i = 0; i < lineCount; i++) {
    const line = doc.lineAt(i).text;
    ASSIGN_RX.lastIndex = 0;
    let m2: RegExpExecArray | null;
    while ((m2 = ASSIGN_RX.exec(line))) {
      const name = m2[1] || '';
      const toks = splitTokens(name);

      const rhs = line.slice(m2.index + m2[0].length).trim();
      // Allow env/secret-backed usages
      if (/(process\.env|import\.meta\.env|Deno\.env\.get\(|Bun\.env|context\.secrets\.get\(|secrets\.get\()/i.test(rhs)) {
        continue;
      }
      const isStringLiteral = /^['"`]/.test(rhs);
      const hasUriWithCreds = /:\/\//.test(rhs) && /@/.test(rhs);

      if (toks.some(t => SENSITIVE_NAME_TOKENS.has(t)) && (isStringLiteral || hasUriWithCreds)) {
        hits.push({
          name: isStringLiteral
            ? 'Sensitive variable assigned literal'
            : 'Sensitive variable with URI credentials',
          line: i + 1,
          col: m2.index + 1,
          preview: line,
        });
      }
      if (hits.length >= 50) return hits;
    }
  }

  return hits;
}

function normalisePath(p: string | undefined): string {
  return (p || '').replace(/\\/g, '/'); // make Windows look like POSIX
}

function getActiveFilePath(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  // Avoid blocking untitled scratch buffers
  if (ed.document.isUntitled) return undefined;
  // Prefer fsPath, fall back to fileName/path for remote URIs
  const fsPath = (ed.document.uri as any)?.fsPath || ed.document.fileName || ed.document.uri.path;
  return normalisePath(fsPath);
}

function isSensitivePath(p: string): boolean {
  const path = normalisePath(p);
  return SENSITIVE_FILE_PATTERNS.some(rx => rx.test(path));
}

async function warnSensitiveFileAndMaybeProceed(): Promise<boolean> {
  const path = getActiveFilePath();
  const lang = vscode.window.activeTextEditor?.document.languageId || '';
  const sensitiveByPath = !!(path && isSensitivePath(path));
  const looksDotenv = /dotenv|env/i.test(lang);
  const contentHits = scanActiveEditorForSensitiveContent();

  if (!sensitiveByPath && !looksDotenv && contentHits.length === 0) return true;

  console.log('[Mantra] Secret guard triggered', {
    path, lang, sensitiveByPath, looksDotenv, hitCount: contentHits.length,
    hitKinds: Array.from(new Set(contentHits.map(h => h.name)))
  });

  await new Promise(r => setTimeout(r, 50));

  const bulletList =
    contentHits.slice(0, 5).map(h => `• ${h.name} (line ${h.line})`).join('\n') +
    (contentHits.length > 5 ? `\n…plus ${contentHits.length - 5} more.` : '');

  const detailParts: string[] = [];
  if (sensitiveByPath || looksDotenv) {
    detailParts.push(`File looks sensitive by type (e.g., .env/keys/credentials):\n${path || '(untitled)'}`);
  }
  if (contentHits.length) {
    detailParts.push(`Potential secrets found:\n${bulletList}\n\nMantra will NOT send content from this file to the model.`);
  }

  const choice = await vscode.window.showWarningMessage(
    'Sensitive content detected',
    { modal: true, detail: detailParts.join('\n\n') },
    'Proceed once',
    'Cancel'
  );

  if (!choice) {
    void vscode.commands.executeCommand('workbench.action.showNotifications');
    vscode.window.showInformationMessage('Mantra blocked LLM on a sensitive file. See Notification Center to proceed once.');
  }

  return choice === 'Proceed once';
}

// Compute added spans (in NEW doc), deletion anchors (where to show a "— N lines removed" tag),
// and simple "moved" hints by matching inserted blocks back into the OLD text.
function computeChangeHints(oldText: string, newText: string): {
  added: Array<[number, number]>;
  removed: Array<{ anchor: number; count: number }>;
  moved: Array<{ start: number; end: number; fromStart: number; fromEnd: number }>;
} {
  const A = oldText.split(/\r?\n/);
  const B = newText.split(/\r?\n/);
  const n = A.length, m = B.length;

  const added: Array<[number, number]> = [];
  const removed: Array<{ anchor: number; count: number }> = [];

  if (n === 0 && m > 0) {
    added.push([0, m - 1]);
  } else if (m === 0 && n > 0) {
    // Everything removed — we can't anchor decorations into an empty doc,
    // the caller will decide how to message this.
  } else if (m > 0) {
    // LCS DP to walk insert/delete/match and gather hints.
    const W = m + 1;
    const dp = new Uint16Array((n + 1) * (m + 1));
    const idx = (i: number, j: number) => i * W + j;

    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[idx(i, j)] = A[i] === B[j]
          ? (dp[idx(i + 1, j + 1)] + 1)
          : Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)]);
      }
    }

    let i = 0, j = 0;
    let addStart = -1;
    let delCount = 0;

    while (i < n && j < m) {
      if (A[i] === B[j]) {
        if (addStart !== -1) { added.push([addStart, j - 1]); addStart = -1; }
        if (delCount) { removed.push({ anchor: j, count: delCount }); delCount = 0; }
        i++; j++;
      } else if (dp[idx(i + 1, j)] >= dp[idx(i, j + 1)]) {
        delCount++; i++; // deletion from old
      } else {
        if (addStart === -1) addStart = j; // insertion into new
        j++;
      }
    }
    if (addStart !== -1) added.push([addStart, m - 1]);
    if (delCount) removed.push({ anchor: Math.max(0, m - 1), count: delCount });
  }

  // Heuristic "moved" detection: if an added span's text exists verbatim in oldText elsewhere,
  // tag it as moved and show the origin line numbers.
  const moved: Array<{ start: number; end: number; fromStart: number; fromEnd: number }> = [];
  if (added.length && n > 0 && m > 0) {
    // Precompute newline offsets to convert oldText offsets -> line numbers quickly.
    const oldOffsets: number[] = [0];
    for (let k = 0; k < oldText.length; k++) if (oldText.charCodeAt(k) === 10) oldOffsets.push(k + 1);
    const offsetToLine = (off: number) => {
      // binary search
      let lo = 0, hi = oldOffsets.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (oldOffsets[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };

    for (const [s, e] of added) {
      const block = B.slice(s, e + 1).join('\n');
      const trimmed = block.replace(/\s+/g, '');
      if (!trimmed) continue; // skip whitespace-only
      const foundAt = oldText.indexOf(block);
      if (foundAt >= 0) {
        const fromStart = offsetToLine(foundAt);
        const fromEnd = fromStart + (e - s);
        // Only call it "moved" if it's not already at roughly the same place.
        if (Math.abs(fromStart - s) > 1) {
          moved.push({ start: s, end: e, fromStart, fromEnd });
        }
      }
    }
  }

  return { added, removed, moved };
}

// Replace the whole doc, then:
//  • flash added lines green
//  • drop inline "— N lines removed" tags at nearby surviving lines
//  • tag moved blocks with "moved from Lx–Ly"
async function replaceDocumentWithHighlight(
  editor: vscode.TextEditor,
  newText: string
): Promise<void> {
  const oldText = editor.document.getText();
  const { added, removed, moved } = computeChangeHints(oldText, newText);

  // Full replace
  const entireRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(oldText.length)
  );
  await editor.edit((eb) => eb.replace(entireRange, newText));

  // If the document is now empty, nothing to decorate.
  if (editor.document.lineCount === 0) return;

  // --- Decoration types (disposed later to avoid leaks) ---
  const addedType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.insertedForeground'),
  });

  const removedType = vscode.window.createTextEditorDecorationType({
    border: '1px solid',
    borderColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.removedForeground'),
  });

  const movedType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
  });

  // --- Added lines: whole-line green flash over each added span ---
  const addedRanges: vscode.DecorationOptions[] = [];
  for (const [startLine, endLine] of added) {
    if (startLine > endLine) continue;
    const start = new vscode.Position(Math.max(0, startLine), 0);
    const endLineClamped = Math.min(editor.document.lineCount - 1, Math.max(0, endLine));
    const end = editor.document.lineAt(endLineClamped).range.end;
    addedRanges.push({ range: new vscode.Range(start, end) });
  }

  // --- Removed lines: inline “— N lines removed” tag near the anchor ---
  const removedRanges: vscode.DecorationOptions[] = [];
  for (const { anchor, count } of removed) {
    if (count <= 0) continue;
    // If anchor is at EOF, attach the tag to the last line.
    const lineIdx = Math.min(
      Math.max(0, (anchor ?? 0)),
      Math.max(0, editor.document.lineCount - 1)
    );
    const lr = editor.document.lineAt(lineIdx).range;
    removedRanges.push({
      range: lr, // non-empty so we can render `after`
      renderOptions: {
        after: {
          contentText: `  — ${count} line${count === 1 ? '' : 's'} removed`,
          color: new vscode.ThemeColor('editorCodeLens.foreground'),
          margin: '0 0 0 12px',
        },
      },
    });
  }

  // --- Moved blocks: subtle left border + “moved from Lx–Ly” tag on first line ---
  const movedRanges: vscode.DecorationOptions[] = [];
  for (const { start, end, fromStart, fromEnd } of moved) {
    if (start > end) continue;
    const clampedStart = Math.max(0, Math.min(start, editor.document.lineCount - 1));
    const clampedEnd = Math.max(0, Math.min(end, editor.document.lineCount - 1));
    const range = new vscode.Range(
      new vscode.Position(clampedStart, 0),
      editor.document.lineAt(clampedEnd).range.end
    );
    const label = `  ⟶ moved from L${fromStart + 1}–L${fromEnd + 1}`;
    movedRanges.push({
      range,
      renderOptions: {
        before: {
          contentText: ' ',
          border: '0 0 0 3px solid',
          borderColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
          margin: '0 6px 0 0',
          width: '0',
        },
        after: {
          contentText: label,
          color: new vscode.ThemeColor('editorCodeLens.foreground'),
          margin: '0 0 0 12px',
        },
      },
    });
  }

  // Apply decorations
  editor.setDecorations(addedType, addedRanges);
  editor.setDecorations(removedType, removedRanges);
  editor.setDecorations(movedType, movedRanges);

  // Dispose after a short delay to prevent leaks & visual clutter
  const DISPOSE_MS = 3500;
  setTimeout(() => {
    try {
      // Clear first (not strictly required since dispose removes them)
      editor.setDecorations(addedType, []);
      editor.setDecorations(removedType, []);
      editor.setDecorations(movedType, []);
    } finally {
      addedType.dispose();
      removedType.dispose();
      movedType.dispose();
    }
  }, DISPOSE_MS);
}

function stripMarkdownCodeFence(text: string): string {
  if (!text) return text;
  const t = text.trim();

  // Exact fenced block: ```lang\n...code...\n```
  let m = t.match(/^```[a-zA-Z0-9+_.-]*\n([\s\S]*?)\n```$/);
  if (m) return m[1];

  // Fenced without final newline before closing ```
  m = t.match(/^```[a-zA-Z0-9+_.-]*\n([\s\S]*?)```$/);
  if (m) return m[1];

  // First fenced block anywhere in the text (even if there's a preface like "modification ")
  m = t.match(/```[a-zA-Z0-9+_.-]*\n([\s\S]*?)```/);
  if (m) return m[1];

  // Tilde fences, just in case
  m = t.match(/^~~~[a-zA-Z0-9+_.-]*\n([\s\S]*?)\n~~~$/);
  if (m) return m[1];

  return t;
}

async function ensureApiKeys(context: vscode.ExtensionContext): Promise<boolean> {
  const commandsOnly = vscode.workspace.getConfiguration('mantra').get<boolean>('commandsOnly', false);

  // Deepgram (speech-to-text) — still required to listen to commands
  if (!deepgramApiKey) {
    try { deepgramApiKey = (await context.secrets.get('DEEPGRAM_API_KEY')) || ''; } catch { }
    if (!deepgramApiKey) {
      deepgramApiKey = await vscode.window.showInputBox({
        prompt: 'Enter your Deepgram API key',
        ignoreFocusOut: true,
        password: true,
      }) || '';
      if (!deepgramApiKey) {
        vscode.window.showWarningMessage('DEEPGRAM_API_KEY is required for transcription.');
        return false;
      }
      await context.secrets.store('DEEPGRAM_API_KEY', deepgramApiKey);
    }
  }

  // Ensure we have a model instance for STT even if LLM is off
  if (!model) {
    // NOTE: pass empty Cerebras key for now; we’ll set it below if needed
    model = new Model('', deepgramApiKey);
  }

  // LLM provider setup — only when LLM is enabled
  if (!commandsOnly) {
    const cfg = vscode.workspace.getConfiguration('mantra');
    const provider = (cfg.get<string>('llmProvider') || 'groq').trim();
    model.setProvider(provider as any);

    if (provider === 'groq') {
      // Groq API key: 1) settings, 2) env var, 3) secret storage, 4) prompt user
      const fromSettings = (cfg.get<string>('groqApiKey') || '').trim();
      if (fromSettings) { groqApiKey = fromSettings; }
      if (!groqApiKey && process.env.GROQ_API_KEY) { groqApiKey = process.env.GROQ_API_KEY; }
      if (!groqApiKey) {
        try { groqApiKey = (await context.secrets.get('GROQ_API_KEY')) || ''; } catch { }
      }
      if (!groqApiKey) {
        groqApiKey = await vscode.window.showInputBox({
          prompt: 'Enter your Groq API key',
          ignoreFocusOut: true,
          password: true,
        }) || '';
        if (!groqApiKey) {
          vscode.window.showWarningMessage('GROQ_API_KEY is required to use Groq LLM features.');
          return false;
        }
      }
      await context.secrets.store('GROQ_API_KEY', groqApiKey);
      model.setGroqApiKey(groqApiKey);
      model.setGroqModel((cfg.get<string>('groqModel') || 'openai/gpt-oss-20b').trim());
    } else {
      // Cerebras API key: 1) settings, 2) env var, 3) secret storage, 4) prompt user
      const fromSettings = (cfg.get<string>('cerebrasApiKey') || '').trim();
      if (fromSettings) { cerebrasApiKey = fromSettings; }
      if (!cerebrasApiKey && process.env.CEREBRAS_API_KEY) { cerebrasApiKey = process.env.CEREBRAS_API_KEY; }
      if (!cerebrasApiKey) {
        try { cerebrasApiKey = (await context.secrets.get('CEREBRAS_API_KEY')) || ''; } catch { }
      }
      if (!cerebrasApiKey) {
        try { cerebrasApiKey = (await context.secrets.get('GROQ_API_KEY')) || ''; } catch { }
      }
      if (!cerebrasApiKey) {
        cerebrasApiKey = await vscode.window.showInputBox({
          prompt: 'Enter your Cerebras API key',
          ignoreFocusOut: true,
          password: true,
        }) || '';
        if (!cerebrasApiKey) {
          vscode.window.showWarningMessage('CEREBRAS_API_KEY is required to use LLM features.');
          return false;
        }
      }
      await context.secrets.store('CEREBRAS_API_KEY', cerebrasApiKey);
      model.setCerebrasApiKey(cerebrasApiKey);
    }
  }

  return true;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Mantra extension activated!');

  // Immediately apply keys from settings on activation
  syncFromSettings();

  // Re-apply whenever the user updates the settings
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('mantra.cerebrasApiKey') ||
        e.affectsConfiguration('mantra.groqApiKey') ||
        e.affectsConfiguration('mantra.groqModel') ||
        e.affectsConfiguration('mantra.llmProvider') ||
        e.affectsConfiguration('mantra.deepgramApiKey') ||
        e.affectsConfiguration('mantra.reasoningEffort') ||
        e.affectsConfiguration('mantra.agentBackend') ||
        e.affectsConfiguration('mantra.commandsOnly')
      ) {
        syncFromSettings();
        const cfg = vscode.workspace.getConfiguration('mantra');
        if (e.affectsConfiguration('mantra.commandsOnly')) {
          sidebar?.postState({ commandsOnly: cfg.get<boolean>('commandsOnly', false) });
        }
        if (model) {
          if (e.affectsConfiguration('mantra.cerebrasApiKey')) {
            const newKey = (cfg.get<string>('cerebrasApiKey') || '').trim();
            if (newKey) { cerebrasApiKey = newKey; model.setCerebrasApiKey(newKey); }
          }
          if (e.affectsConfiguration('mantra.groqApiKey')) {
            const newKey = (cfg.get<string>('groqApiKey') || '').trim();
            if (newKey) { groqApiKey = newKey; model.setGroqApiKey(newKey); }
          }
        }
      }
    })
  );

  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Mantra');
  }

  const onboarded = context.globalState.get<boolean>('mantra.onboarded');
  if (!onboarded) {
    vscode.window.showInformationMessage(
      'Mantra uses Deepgram Flux for speech recognition with built-in turn detection. Just speak naturally!',
      'Open Settings',
      'OK'
    ).then(pick => {
      if (pick === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'mantra.');
      }
    });
    await context.globalState.update('mantra.onboarded', true);
  }

  const startDisposable = vscode.commands.registerCommand('mantra.start', async () => {
    if (__mantraSessionActive) {
      vscode.window.showInformationMessage('Mantra is already listening.');
      console.log('[Mantra] Session already active, ignoring start');
      return;
    }
    __mantraPaused = false;
    __mantraSessionActive = true;
    stopMicTest(); // stop test if running
    if (!(await ensureApiKeys(context))) return;

    console.log('[Mantra] STT model: Flux');

    // Single progress notification for the whole session — updates in-place
    // with live transcription, no spam
    let reportProgress: ((msg: string) => void) | undefined;
    let endProgress: (() => void) | undefined;

    const progressPromise = vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Mantra', cancellable: true },
      (progress, cancelToken) => new Promise<void>((resolve) => {
        reportProgress = (msg: string) => progress.report({ message: msg });
        endProgress = resolve;
        cancelToken.onCancellationRequested(() => {
          __mantraPaused = true;
          pauseRecording();
          resolve();
        });
      })
    );

    reportProgress?.('Listening...');

    // Push listening state + provider info to sidebar
    {
      const cfg = vscode.workspace.getConfiguration('mantra');
      const prov = cfg.get<string>('llmProvider') || 'groq';
      const gm = cfg.get<string>('groqModel') || 'openai/gpt-oss-20b';
      const provLabel = prov === 'groq' ? `Groq / ${gm.replace('openai/', '')}` : 'Cerebras';
      sidebar?.postState({ listening: true, provider: provLabel });
    }

    // Volume metering → sidebar
    onVolume((level) => sidebar?.postState({ volume: level }));

    // Loop: mic → Deepgram stream → final transcript → route → repeat
    while (!__mantraPaused) {
      try {
        await startMicStream(context, async (pcm) => {
          // Push mic name to sidebar (resolved inside startMicStream before this callback)
          sidebar?.postState({ mic: getMicName() });

          // Send PCM to Deepgram; show live transcription in the notification
          let transcript = await model!.transcribeStream(pcm, (partial) => {
            if (partial) reportProgress?.(partial);
          });

          // Reset notification after transcription completes
          reportProgress?.('Listening...');

          if (!transcript) return;

          // Fix common Deepgram misrecognition: "codecs" → "codex"
          // Deepgram often hears "codex" as "codecs" since it's a more common English word
          transcript = transcript.replace(/\bcodecs\b/gi, 'codex');

          // Secondary noise filter — catch anything the STT noise gate missed
          // In agent mode, allow yes/no/yeah/ok through (needed for permission prompts)
          const inAgent = isAgentModeActive();
          const NOISE_RE = inAgent
            ? /^(two|to|too|four|for|ate|eight|one|won|the|a|an|uh|um|oh|ah|hmm|huh|it|is|i|so|but|hey|hi|bye|hm|mm)\.?$/i
            : /^(two|to|too|four|for|ate|eight|one|won|the|a|an|uh|um|oh|ah|hmm|huh|it|is|i|so|but|yeah|yep|nah|no|yes|ok|hey|hi|bye|hm|mm)\.?$/i;
          if (NOISE_RE.test(transcript.trim())) {
            console.log('[Mantra] Secondary noise filter caught:', transcript);
            return;
          }

          console.log('[Mantra] Transcript: ', transcript);
          sidebar?.postState({ lastTranscript: transcript });
          pushLog('transcript', transcript);

          // --- PAUSE/RESUME interception (pre-LLM) ---
          const t = transcript.trim().toLowerCase();
          if (/(^|\b)(pause|stop listening)(\b|$)/.test(t)) {
            vscode.window.showInformationMessage('Pausing Mantra...use keyboard shortcut to resume');
            pushLog('command', 'Paused listening');
            __mantraPaused = true;
            pauseRecording();
            return;
          }
          if (/(^|\b)(resume|start listening)(\b|$)/.test(t)) {
            // already running; fall through
          }

          // --- terminal execute / enter shortcut (pre-LLM) ---
          // Use both t (raw) and tc (punctuation-stripped) — Flux often adds "."
          if (/^(execute|execute that|run that|hit enter|press enter|submit|enter)\.?$/i.test(t)) {
            if (isAgentModeActive()) {
              confirmSelectedAgent();
              pushLog('command', `Confirmed ${getSelectedAgent()} (Enter)`);
            } else {
              executeLastTyped();
              pushLog('terminal', 'Executed last typed command');
            }
            return;
          }

          // --- Auto-detect agent mode from active terminal ---
          // Only auto-activate the SELECTED agent's mode
          {
            const agent = getSelectedAgent();
            if (agent === 'claude' && !isClaudeMode() && isClaudeTerminalActive()) {
              setClaudeMode(true);
            }
            if (agent === 'codex' && !isCodexMode() && isCodexTerminalActive()) {
              setCodexMode(true);
            }
          }

          // --- Claude diff actions (always available) ---
          if (/^(accept|accept changes|accept claude changes|accept diff)$/i.test(t)) {
            await acceptClaudeChanges();
            pushLog('claude', 'Accepted Claude changes');
            return;
          }
          if (/^(reject|reject changes|reject claude changes|reject diff)$/i.test(t)) {
            await rejectClaudeChanges();
            pushLog('claude', 'Rejected Claude changes');
            return;
          }

          // --- Claude CLI commands (always available) ---
          if (/^(new conversation|new claude conversation|new chat|clear conversation|clear chat|start over|start fresh)$/i.test(t)) {
            await claudeNewConversation();
            pushLog('claude', 'New conversation');
            return;
          }
          if (/^(resume|resume conversation|resume chat|continue conversation|continue chat|pick up where we left off)$/i.test(t)) {
            await claudeResume();
            pushLog('claude', 'Resume conversation');
            return;
          }
          if (/^(claude help|show help|help claude|what can you do)$/i.test(t)) {
            await claudeHelp();
            pushLog('claude', 'Claude help');
            return;
          }
          if (/^(claude status|show status|status)$/i.test(t) && isClaudeMode()) {
            await claudeStatus();
            pushLog('claude', 'Claude status');
            return;
          }
          if (/^(compact|compact conversation|summarize conversation|compact chat)$/i.test(t) && isClaudeMode()) {
            await claudeCompact();
            pushLog('claude', 'Compact conversation');
            return;
          }
          if (/^(undo|undo that|undo last|undo claude)$/i.test(t) && isClaudeMode()) {
            await claudeUndo();
            pushLog('claude', 'Claude undo');
            return;
          }
          if (/^(stop|cancel|interrupt|stop claude|cancel claude|stop codex|cancel codex|stop agent|cancel agent|nevermind|never mind)$/i.test(t) && isAgentModeActive()) {
            interruptSelectedAgent();
            pushLog(getSelectedAgent(), `Interrupted ${getSelectedAgent()}`);
            return;
          }
          // "set model to X" / "use sonnet" / "switch to opus" etc.
          {
            const modelMatch = t.match(/^(?:set model(?: to)?|use model|use|switch to|change model(?: to)?)[\s]+(sonnet|opus|haiku|claude[\s-]?3[\s.-]?5[\s-]?sonnet|claude[\s-]?3[\s.-]?5[\s-]?haiku|claude[\s-]?3[\s.-]?5[\s-]?opus)$/i);
            if (modelMatch) {
              await claudeSetModel(modelMatch[1].trim());
              return;
            }
          }

          // --- system-level shortcuts (always available, pre-LLM) ---
          // Strip trailing punctuation for cleaner matching (Flux often adds "." or "?")
          const tc = t.replace(/[.,!?;:]+$/, '').trim();

          // Generic keyboard shortcuts via osascript (macOS)
          // "command B", "control shift P", "command shift F", etc.
          if (process.platform === 'darwin') {
            const kbMatch = tc.match(/^((?:(?:command|cmd|control|ctrl|alt|option|shift)[\s+]*)+)([a-z0-9/\\[\]'`,.\-=])$/i);
            if (kbMatch) {
              const modsRaw = kbMatch[1].toLowerCase();
              const key = kbMatch[2];
              const usings: string[] = [];
              if (/command|cmd/.test(modsRaw)) usings.push('command down');
              if (/control|ctrl/.test(modsRaw)) usings.push('control down');
              if (/alt|option/.test(modsRaw)) usings.push('option down');
              if (/shift/.test(modsRaw)) usings.push('shift down');
              const usingClause = usings.length > 0 ? ` using {${usings.join(', ')}}` : '';
              const script = `tell application "System Events" to keystroke "${key}"${usingClause}`;
              exec(`osascript -e '${script}'`, (err) => {
                if (err) console.warn('[Mantra] osascript keystroke failed:', err.message);
              });
              vscode.window.setStatusBarMessage(`⌨️ ${modsRaw.trim()} ${key}`, 1500);
              pushLog('command', `Keystroke: ${modsRaw.trim()} ${key}`);
              return;
            }
          }

          // "click" → simulate mouse click via osascript
          if (/^click$/i.test(tc)) {
            if (process.platform === 'darwin') {
              exec(`osascript -e 'tell application "System Events" to key code 36'`, (err) => {
                if (err) console.warn('[Mantra] click failed:', err.message);
              });
            } else if (isAgentModeActive()) {
              confirmSelectedAgent();
            } else {
              executeLastTyped();
            }
            return;
          }

          // Open apps (macOS) — strip punctuation from app name
          if (process.platform === 'darwin') {
            const appMatch = tc.match(/^open\s+(.+)$/i);
            if (appMatch) {
              const appName = appMatch[1].replace(/[.,!?;:]+$/, '').trim();
              exec(`open -a "${appName}"`, (err) => {
                if (err) vscode.window.showWarningMessage(`Could not open "${appName}": ${err.message}`);
              });
              vscode.window.setStatusBarMessage(`Opening ${appName}...`, 2000);
              pushLog('command', `Open app: ${appName}`);
              return;
            }
          }

          // --- Agent mode: "enter"/"yes" to confirm, arrow keys ---
          if (isAgentModeActive()) {
            // Enter / confirm (use tc for punctuation-stripped matching)
            if (/^(yes|yeah|yep|sure|allow|confirm|go ahead|do it|proceed|ok|okay|enter|select|sounds good)$/i.test(tc)) {
              confirmSelectedAgent();
              return;
            }
            // Arrow keys for navigating agent menus
            if (/^(up|go up|move up|previous|arrow up)$/i.test(tc)) {
              agentArrowUp();
              return;
            }
            if (/^(down|go down|move down|next|arrow down)$/i.test(tc)) {
              agentArrowDown();
              return;
            }
          }

          // --- focus management (always available, use tc for punctuation tolerance) ---
          if (/^(focus editor|go to editor|go to code|switch to editor|back to editor|back to code|exit claude|leave claude|exit codex|leave codex|exit agent|leave agent|stop claude mode|stop codex mode|stop agent mode|go back|go back to editor)$/i.test(tc)) {
            if (isClaudeMode()) setClaudeMode(false);
            if (isCodexMode()) setCodexMode(false);
            await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
            vscode.window.setStatusBarMessage('Focused editor', 1500);
            pushLog('command', 'Focus editor');
            return;
          }
          if (/^(focus terminal|go to terminal|switch to terminal|back to terminal)$/i.test(tc)) {
            if (isClaudeMode()) setClaudeMode(false);
            if (isCodexMode()) setCodexMode(false);
            await vscode.commands.executeCommand('workbench.action.terminal.focus');
            pushLog('command', 'Focus terminal');
            return;
          }

          // --- commands-only check (read once for this utterance) ---
          const commandsOnly = vscode.workspace.getConfiguration('mantra').get<boolean>('commandsOnly', false);

          // --- quick command paths ---
          const maybeHandled = await tryExecuteMappedCommand(transcript);
          if (maybeHandled) { pushLog('command', transcript); return; }
          if (await handleTextCommand(transcript, context)) { pushLog('command', transcript); return; }

          // --- LLM disabled? ---
          if (commandsOnly) {
            console.log(`[Mantra] Commands-only: no match for "${transcript}"`);
            vscode.window.setStatusBarMessage(`Commands-only: unrecognized "${transcript}"`, 2000);
            return;
          }

          // --- "ask codex/claude/agent/LLM <prompt>" pre-LLM shortcut ---
          {
            const agentAskMatch = tc.match(/^(?:ask|tell|hey)\s+(?:codex|claude|agent|llm|ai|the\s+agent|the\s+llm)\b[,\s]*(.+)/i);
            if (agentAskMatch && agentAskMatch[1].trim()) {
              const prompt = agentAskMatch[1].replace(/^(uh|um|like|so|to|,)+\s*/i, '').trim();
              if (prompt) {
                const agent = getSelectedAgent();
                if (isAgentModeActive()) {
                  typeInSelectedAgent(prompt);
                } else {
                  await sendToSelectedAgent(buildClaudePrompt(prompt));
                }
                pushLog(agent, prompt);
                return;
              }
            }
          }

          // --- enter agent mode explicitly (all names route to selected agent) ---
          if (/^(focus claude|switch to claude|go to claude|open claude|claude mode|talk to claude|focus codex|switch to codex|go to codex|open codex|codex mode|talk to codex|focus agent|switch to agent|go to agent|open agent|agent mode|talk to agent|focus llm|open llm|talk to llm)$/i.test(t)) {
            await focusSelectedAgent();
            pushLog('command', `Focus ${getSelectedAgent()}`);
            return;
          }

          // --- ensure LLM key if needed ---
          if (!model || !model.hasLlm()) {
            const ok = await ensureApiKeys(context);
            if (!ok || !model?.hasLlm()) return;
          }

          // --- build routing context ---
          const editor = vscode.window.activeTextEditor || null;
          const editorContext = (editor
            ? [
              `Active file language: ${editor.document.languageId}`,
              `Total lines: ${editor.document.lineCount}`,
            ].join('\n')
            : '(no active editor)');

          if (!(await warnSensitiveFileAndMaybeProceed())) return;

          const commandsList = canonicalCommandPhrases();

          // --- decide + apply result ---
          const termHistory = getFullTerminalHistory();
          let result: any;
          try {
            result = await model!.decide(transcript, {
              editorContext,
              commands: commandsList,
              filename: editor?.document.fileName,
              editor: editor || undefined,
              terminalHistory: termHistory || undefined,
            });
          } catch (err: any) {
            const status = (err && (err.status || err.code)) ?? 0;
            const isRate = status === 429 || /rate/i.test(String(err?.message || err));
            const msg = isRate
              ? `Cerebras rate limit hit: ${String(err?.message || 'Too many requests')}`
              : `Cerebras request failed: ${String(err?.message || err)}`;
            console.error('[Mantra] LLM error', err);
            if (outputChannel) {
              outputChannel.appendLine(`ERROR: ${msg}`);
              outputChannel.show(true);
            }
            vscode.window.showErrorMessage(msg);
            pushLog('error', msg);
            return;
          }

          if (result.type === 'terminal') {
            const shellCmd = (result.payload || '').trim();
            if (shellCmd) {
              // Default: execute immediately. Only hold back if user says to wait/not run.
              const shouldWait = /\b(don'?t (run|execute)|but (wait|hold|don'?t)|and (wait|hold)|just type|type it|don'?t hit enter|wait)\b/i.test(transcript);
              if (shouldWait) {
                typeInTerminal(shellCmd);
                pushLog('terminal', `Typed: ${shellCmd}`);
              } else {
                executeInTerminal(shellCmd);
                pushLog('terminal', `Executed: ${shellCmd}`);
              }
            }
          } else if (result.type === 'claude' || result.type === 'codex' || result.type === 'agent') {
            // All agent types route to the currently selected agent
            const prompt = (result.payload || '').trim();
            if (prompt) {
              const agent = getSelectedAgent();
              if (isAgentModeActive()) {
                typeInSelectedAgent(prompt);
              } else {
                await sendToSelectedAgent(buildClaudePrompt(prompt));
              }
              pushLog(agent, prompt);
            }
          } else if (result.type === 'command') {
            const phrase = (result.payload || '').toString().trim();
            const ok =
              (await handleTextCommand(phrase, context)) ||
              (await tryExecuteMappedCommand(phrase));
            if (!ok) {
              vscode.window.showWarningMessage(`Unknown command: ${phrase}`);
              pushLog('error', `Unknown command: ${phrase}`);
            } else {
              pushLog('command', phrase);
            }
          } else if (result.type === 'modification') {
            if (!editor) {
              vscode.window.showWarningMessage('No active editor for modification.');
            } else {
              const oldText = editor.document.getText();
              const newText = stripMarkdownCodeFence(result.payload ?? '');
              const filename = editor.document.fileName.split(/[\\/]/).pop() || 'file';
              const diff = makeUnifiedDiff(oldText, newText, filename);
              await replaceDocumentWithHighlight(editor, newText);
              vscode.window.setStatusBarMessage('Applied modification from LLM', 3000);
              pushLog('modification', `Modified ${filename}`, diff || undefined);
            }
          } else {
            // "question" type — if agent is active, type into it;
            // otherwise show answer in the output panel.
            if (isAgentModeActive()) {
              typeInSelectedAgent(transcript);
              pushLog(getSelectedAgent(), transcript);
            } else {
              const answer = result.payload;
              if ((answer || '').toLowerCase().replace(/[^\w\s]/g, '').trim() === 'thank you') return;
              if (outputChannel && answer) {
                const sep = '─'.repeat(60);
                const time = new Date().toLocaleTimeString();
                const q = transcript.trim();
                const a = (answer || '').trim();
                outputChannel.appendLine(`[${time}] Q: ${q}`);
                outputChannel.appendLine(a);
                outputChannel.appendLine(sep);
                outputChannel.show(true);
              } else {
                vscode.window.showInformationMessage(answer || '(no answer)');
              }
              pushLog('question', (answer || '').trim().substring(0, 200));
            }
          }

          // Update conversation memory in the background (non-blocking)
          if (model && result) {
            model.updateMemory(transcript, result, termHistory || undefined)
              .then(() => sidebar?.postState({ memory: model!.getMemory() }))
              .catch(() => {});
          }
        });
      } catch (err: any) {
        const msg = String(err?.message || err);
        console.error('[Mantra] Loop iteration error:', msg);

        // Stop retrying on connection/auth errors (400, 401, 403)
        if (/400|401|403|Unexpected server response|API key/i.test(msg)) {
          vscode.window.showErrorMessage(`Mantra STT error: ${msg}`);
          __mantraPaused = true;
          pauseRecording();
          break;
        }

        // For transient errors, wait before retrying
        await new Promise((res) => setTimeout(res, 2000));
      }

      // small idle so we don't spin if the recorder stops
      if (!recorderActive()) await new Promise((res) => setTimeout(res, 100));
    }

    // Close the progress notification when loop exits
    offVolume();
    sidebar?.postState({ listening: false, volume: 0 });
    if (endProgress) endProgress();
    await progressPromise;
    __mantraSessionActive = false;
  });

  const pauseDisposable = vscode.commands.registerCommand('mantra.pause', () => {
    __mantraPaused = true;
    __mantraSessionActive = false;
    offVolume();
    pauseRecording();
    sidebar?.postState({ listening: false, volume: 0 });
    vscode.window.showInformationMessage('Mantra paused');
    console.log('Paused');
  });

  const configurePromptDisposable = vscode.commands.registerCommand('mantra.configurePrompt', async () => {
    try {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'mantra.prompt');
    } catch (e) {
      console.log('Failed to open settings to mantra.prompt; opening Settings UI instead', e);
      await vscode.commands.executeCommand('workbench.action.openSettings');
    }
  });

  const toggleCommandsOnlyDisposable = vscode.commands.registerCommand(
    'mantra.toggleCommandsOnly',
    async () => {
      const cfg = vscode.workspace.getConfiguration('mantra');
      const current = cfg.get<boolean>('commandsOnly', false);
      await cfg.update('commandsOnly', !current, vscode.ConfigurationTarget.Global);
      sidebar?.postState({ commandsOnly: !current });
      vscode.window.setStatusBarMessage(
        `Mantra: commands-only ${!current ? 'enabled' : 'disabled'}`,
        2000
      );
    });

  const selectMicDisposable = vscode.commands.registerCommand('mantra.selectMicrophone', async () => {
    function resolveFfmpegCmd(): string {
      const env = (process.env.MANTRA_FFMPEG_PATH || '').trim();
      if (env) return env;
      const cmd = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
      try {
        if (spawnSync(cmd, ['-version'], { encoding: 'utf8' }).status === 0) return cmd;
      } catch { }
      const staticPath = (ffmpegStatic as unknown as string) || '';
      if (staticPath) return staticPath;
      throw new Error('FFmpeg not found. Install ffmpeg or set MANTRA_FFMPEG_PATH.');
    }

    // ---------- Windows (DirectShow) ----------
    function listWindowsDshow(ff: string): string[] {
      try {
        const r = spawnSync(ff, ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], { encoding: 'utf8' });
        const out = (r.stdout || '') + (r.stderr || '');
        const lines = out.split(/\r?\n/);
        const audioStart = lines.findIndex(l => /DirectShow audio devices/i.test(l));
        if (audioStart < 0) return [];
        const devs: string[] = [];
        for (let i = audioStart + 1; i < lines.length; i++) {
          const m = lines[i].match(/"([^"]+)"/);
          if (m) devs.push(m[1]);
          if (/DirectShow video devices/i.test(lines[i])) break;
        }
        return Array.from(new Set(devs));
      } catch { return []; }
    }

    // ---------- macOS (AVFoundation) ----------
    function listMacAvfoundation(ff: string): { items: Array<{ label: string, index: string }>, supported: boolean } {
      try {
        const r = spawnSync(ff, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
        const out = (r.stdout || '') + (r.stderr || '');
        if (/Unknown input format.*avfoundation/i.test(out)) {
          return { items: [], supported: false };
        }
        const lines = out.split(/\r?\n/);
        const start = lines.findIndex(l => /AVFoundation audio devices/i.test(l));
        const items: Array<{ label: string, index: string }> = [];
        if (start >= 0) {
          for (let i = start + 1; i < lines.length; i++) {
            const line = lines[i];
            if (/AVFoundation video devices/i.test(line)) break;
            // Accept both: [0] Built-in Microphone  OR  [0] "Built-in Microphone"
            const m = line.match(/\[(\d+)\]\s*(?:"([^"]+)"|(.+))$/);
            if (m) {
              const idx = m[1];
              const name = (m[2] || m[3] || '').trim();
              if (name) items.push({ index: idx, label: name });
            }
          }
        }
        return { items, supported: true };
      } catch { return { items: [], supported: false }; }
    }

    // ---------- Linux / WSLg (PulseAudio) ----------
    function listPulseSources(): Array<{ name: string }> {
      try {
        const r = spawnSync('pactl', ['list', 'short', 'sources'], { encoding: 'utf8' });
        if (r.status !== 0) return [];
        const items: Array<{ name: string }> = [];
        for (const line of (r.stdout || '').split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const name = parts[1];
            if (name && !/\.monitor$/.test(name)) items.push({ name });
          }
        }
        return items;
      } catch { return []; }
    }

    const cfg = vscode.workspace.getConfiguration('mantra');
    let ff = '';
    try { ff = resolveFfmpegCmd(); } catch { }

    type MicItem = vscode.QuickPickItem & { args: string };
    const items: MicItem[] = [];

    if (process.platform === 'win32') {
      items.push({
        label: '$(device-camera-microphone) System Default (WASAPI)',
        description: 'Use the system default input',
        args: '-f wasapi -i default'
      });
      const dshow = ff ? listWindowsDshow(ff) : [];
      for (const dev of dshow) {
        const quoted = dev.includes(' ') ? `"${dev}"` : dev;
        items.push({
          label: `$(radio-tower) ${dev}`,
          description: 'DirectShow device',
          detail: 'FFmpeg: -f dshow -i audio=…',
          args: `-f dshow -i audio=${quoted}`
        });
      }
    } else if (process.platform === 'darwin') {
      items.push({
        label: '$(device-camera-microphone) System Default (AVFoundation)',
        description: 'Use the system default input',
        args: '-f avfoundation -i :default'
      });

      if (ff) {
        const { items: av, supported } = listMacAvfoundation(ff);
        if (!supported) {
          vscode.window.showWarningMessage(
            'Your FFmpeg does not support AVFoundation. Install a Homebrew FFmpeg and restart VS Code: brew install ffmpeg'
          );
        }
        for (const a of av) {
          items.push({
            label: `$(radio-tower) ${a.label}`,
            description: `AVFoundation index ${a.index}`,
            detail: 'FFmpeg: -f avfoundation -i :<index>',
            args: `-f avfoundation -i :${a.index}`
          });
        }
      }
    } else {
      items.push({
        label: '$(device-camera-microphone) Default (PulseAudio)',
        description: 'Use the default PulseAudio source',
        args: '-f pulse -i default'
      });
      const srcs = listPulseSources();
      for (const s of srcs) {
        items.push({
          label: `$(radio-tower) ${s.name}`,
          description: 'PulseAudio source',
          detail: 'FFmpeg: -f pulse -i <source>',
          args: `-f pulse -i ${s.name}`
        });
      }
    }

    if (items.length === 0) {
      vscode.window.showErrorMessage('No microphones found. Ensure audio permissions are granted and FFmpeg is installed.');
      return;
    }

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a microphone to use with Mantra',
      canPickMany: false,
      ignoreFocusOut: true,
      matchOnDetail: true,
      matchOnDescription: true
    });
    if (!pick) return;

    await cfg.update('microphoneInput', pick.args, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Mantra mic set: ${pick.label}`, 3000);
    sidebar?.postState({ mic: pick.label });
  });

  const openSettingsCmd = vscode.commands.registerCommand(
    'mantra.openSettings',
    () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mishra7yash.mantra')
  );

  const editCerebrasCmd = vscode.commands.registerCommand(
    'mantra.editCerebrasApiKey',
    () => vscode.commands.executeCommand('workbench.action.openSettings', '@id:mantra.cerebrasApiKey')
  );

  const editGroqCmd = vscode.commands.registerCommand(
    'mantra.editGroqApiKey',
    () => vscode.commands.executeCommand('workbench.action.openSettings', '@id:mantra.groqApiKey')
  );

  const editDeepgramCmd = vscode.commands.registerCommand(
    'mantra.editDeepgramApiKey',
    () => vscode.commands.executeCommand('workbench.action.openSettings', '@id:mantra.deepgramApiKey')
  );

  context.subscriptions.push(openSettingsCmd, editCerebrasCmd, editGroqCmd, editDeepgramCmd);

  // Track terminal command history for Claude context
  context.subscriptions.push(...initTerminalHistory());

  // Focus Claude Code sidebar panel (routes to selected agent)
  const focusClaudeDisposable = vscode.commands.registerCommand('mantra.focusClaude', () => {
    focusSelectedAgent();
  });

  // Focus Codex CLI terminal (routes to selected agent)
  const focusCodexDisposable = vscode.commands.registerCommand('mantra.focusCodex', () => {
    focusSelectedAgent();
  });

  // Focus the currently selected agent
  const focusAgentDisposable = vscode.commands.registerCommand('mantra.focusAgent', () => {
    focusSelectedAgent();
  });

  // Sidebar panel
  sidebar = new MantraSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MantraSidebarProvider.viewType, sidebar)
  );

  // Memory editing from sidebar
  sidebar.onMemoryEdit((text) => {
    if (model) {
      model.setMemory(text);
      console.log(`[Mantra] Memory edited by user (${text.length} chars)`);
    }
  });

  // Prompt editing from sidebar
  sidebar.onPromptEdit((key, text) => {
    const cfg = vscode.workspace.getConfiguration('mantra');
    cfg.update(key, text, vscode.ConfigurationTarget.Global);
    console.log(`[Mantra] Prompt "${key}" updated from sidebar (${text.length} chars)`);
  });

  // Agent backend change from sidebar
  sidebar.onAgentChange((agent) => {
    const cfg = vscode.workspace.getConfiguration('mantra');
    cfg.update('agentBackend', agent, vscode.ConfigurationTarget.Global);
    console.log(`[Mantra] Agent backend changed to: ${agent}`);

    // Close the other agent's terminal to enforce mutual exclusivity
    if (agent === 'claude') {
      closeCodexTerminal();
    } else {
      closeClaudeTerminal();
    }

    // Check if the new agent is installed and push status to sidebar
    const installed = agent === 'claude' ? true : checkCliInstalled('codex');
    sidebar?.postState({ agentBackend: agent, agentInstalled: installed });
  });

  // LLM provider change from sidebar
  sidebar.onProviderChange((provider) => {
    const cfg = vscode.workspace.getConfiguration('mantra');
    cfg.update('llmProvider', provider, vscode.ConfigurationTarget.Global);
    if (model) model.setProvider(provider as any);
    console.log(`[Mantra] LLM provider changed to: ${provider}`);
  });

  // Model change from sidebar
  sidebar.onModelChange((modelId) => {
    const cfg = vscode.workspace.getConfiguration('mantra');
    const provider = cfg.get<string>('llmProvider') || 'groq';
    if (provider === 'groq') {
      cfg.update('groqModel', modelId, vscode.ConfigurationTarget.Global);
      if (model) model.setGroqModel(modelId);
    }
    console.log(`[Mantra] LLM model changed to: ${modelId}`);
  });

  // Install agent from sidebar
  sidebar.onInstallAgent(() => {
    const agent = getSelectedAgent();
    const pkg = agent === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
    const installTerminal = vscode.window.createTerminal({ name: `Install ${agent}`, isTransient: true });
    installTerminal.show(true);
    installTerminal.sendText(`npm install -g ${pkg}`, true);
    console.log(`[Mantra] Installing ${agent} via npm`);
  });

  // Push initial state to sidebar
  {
    const cfg = vscode.workspace.getConfiguration('mantra');
    const agent = cfg.get<string>('agentBackend') || 'claude';
    const provider = cfg.get<string>('llmProvider') || 'groq';
    const groqModel = cfg.get<string>('groqModel') || 'openai/gpt-oss-20b';
    const installed = agent === 'claude' ? true : checkCliInstalled('codex');
    const cmdOnly = cfg.get<boolean>('commandsOnly', false);
    sidebar.postState({
      routerPrompt: cfg.get<string>('prompt') || '',
      memoryPrompt: cfg.get<string>('memoryPrompt') || '',
      agentBackend: agent,
      agentInstalled: installed,
      llmProvider: provider,
      llmModel: groqModel,
      commandsOnly: cmdOnly,
    });
  }

  // Test microphone command (volume meter only, no STT)
  const testMicCmd = vscode.commands.registerCommand('mantra.testMicrophone', () => {
    if (isMicTesting()) {
      stopMicTest();
      sidebar?.postState({ testing: false, volume: 0 });
      return;
    }
    sidebar?.postState({ testing: true });
    testMic(context, (level, micName) => {
      sidebar?.postState({ volume: level, mic: micName });
    }).then(() => {
      sidebar?.postState({ testing: false, volume: 0 });
    });
  });

  // Add to subscriptions:
  context.subscriptions.push(
    startDisposable,
    pauseDisposable,
    configurePromptDisposable,
    toggleCommandsOnlyDisposable,
    selectMicDisposable,
    openSettingsCmd,
    editCerebrasCmd,
    editGroqCmd,
    editDeepgramCmd,
    focusClaudeDisposable,
    focusCodexDisposable,
    focusAgentDisposable,
    testMicCmd
  );
}

export function deactivate() {
  __mantraPaused = true;
  pauseRecording();
  console.log('Extension deactivated');
}