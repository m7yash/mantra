import * as vscode from 'vscode';
import { startMicStream, pauseRecording, recorderActive, onVolume, offVolume, getMicName, testMic, stopMicTest, isMicTesting } from './recorder';
import { Model } from './model';
import { canonicalCommandPhrases, tryExecuteMappedCommand } from './commands';
import { handleCommand as handleTextCommand } from './textOps';
import { trySystemCommand } from './systemCommands';
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
let aquavoiceApiKey: string = '';
let outputChannel: vscode.OutputChannel | null = null;
let sidebar: MantraSidebarProvider | null = null;

// Track explicit pause state separate from recorder process state
let __mantraPaused = false;
// Guard against double-entry into the listening loop
let __mantraSessionActive = false;
// When set, the current recording should be force-transcribed then paused
let __stopAndTranscribe = false;

// ── Diff store for "Open in tab" ──
const diffStore = new Map<number, { oldText: string; newText: string; filename: string; fullDocBefore?: string; fullDocAfter?: string }>();
let diffIdCounter = 0;

function storeDiff(oldText: string, newText: string, filename: string, fullDocBefore?: string, fullDocAfter?: string): number {
  const id = diffIdCounter++;
  diffStore.set(id, { oldText, newText, filename, fullDocBefore, fullDocAfter });
  // Keep at most 50 entries to avoid unbounded memory growth
  if (diffStore.size > 50) {
    const oldest = diffStore.keys().next().value;
    if (oldest !== undefined) diffStore.delete(oldest);
  }
  return id;
}

/** Check if a stored diff can be undone (current file content matches the full doc snapshot after the edit). */
function isDiffUndoable(diffId: number): boolean {
  const data = diffStore.get(diffId);
  if (!data) return false;
  if (!data.fullDocAfter) return false; // legacy entry without snapshot
  // Find the editor for this file
  const editor = vscode.window.visibleTextEditors.find(
    e => e.document.fileName.endsWith(data.filename) || e.document.fileName.split(/[\\/]/).pop() === data.filename
  );
  if (!editor) return false;
  return editor.document.getText() === data.fullDocAfter;
}

/** Get all diff IDs that are now stale (can't be undone). */
function getStaleDiffIds(): number[] {
  const stale: number[] = [];
  for (const [id] of diffStore) {
    if (!isDiffUndoable(id)) stale.push(id);
  }
  return stale;
}

/** Notify sidebar about stale and undoable undo buttons. */
function notifyStaleDiffs(): void {
  if (!sidebar) return;
  const stale: number[] = [];
  const undoable: number[] = [];
  for (const [id] of diffStore) {
    if (isDiffUndoable(id)) undoable.push(id);
    else stale.push(id);
  }
  const state: any = {};
  if (stale.length > 0) state.staleDiffIds = stale;
  if (undoable.length > 0) state.undoableDiffIds = undoable;
  if (stale.length > 0 || undoable.length > 0) sidebar.postState(state);
}

/** Push a log entry to the sidebar activity log. */
function pushLog(kind: LogEntry['kind'], text: string, diff?: string, diffId?: number): void {
  if (!sidebar) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  sidebar.pushLog({ time, kind, text, diff, diffId });
}

/** In-memory agent selection — updated synchronously on dropdown change, avoids async config race. */
let __selectedAgent: 'claude' | 'codex' | 'none' = vscode.workspace.getConfiguration('mantra').get<string>('agentBackend', 'none') as 'claude' | 'codex' | 'none';

/** Get the currently selected agent backend. */
function getSelectedAgent(): 'claude' | 'codex' | 'none' {
  return __selectedAgent;
}

/** Check if the selected agent's mode or terminal is active (voice should go to agent). */
function isAgentModeActive(): boolean {
  const agent = getSelectedAgent();
  if (agent === 'none') return false;
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

// ── Microphone enumeration (shared by sidebar dropdown & command palette) ──

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

/** Enumerate available microphones for the current platform. */
function enumerateMicrophones(): Array<{ label: string; args: string }> {
  let ff = '';
  try { ff = resolveFfmpegCmd(); } catch { }

  const items: Array<{ label: string; args: string }> = [];

  if (process.platform === 'win32') {
    items.push({ label: 'System Default (WASAPI)', args: '-f wasapi -i default' });
    const dshow = ff ? listWindowsDshow(ff) : [];
    for (const dev of dshow) {
      const quoted = dev.includes(' ') ? `"${dev}"` : dev;
      items.push({ label: dev, args: `-f dshow -i audio=${quoted}` });
    }
  } else if (process.platform === 'darwin') {
    items.push({ label: 'System Default (AVFoundation)', args: '-f avfoundation -i :default' });
    if (ff) {
      const { items: av } = listMacAvfoundation(ff);
      for (const a of av) {
        items.push({ label: a.label, args: `-f avfoundation -i :${a.index}` });
      }
    }
  } else {
    items.push({ label: 'Default (PulseAudio)', args: '-f pulse -i default' });
    const srcs = listPulseSources();
    for (const s of srcs) {
      items.push({ label: s.name, args: `-f pulse -i ${s.name}` });
    }
  }

  return items;
}

function syncFromSettings() {
  const cfg = vscode.workspace.getConfiguration('mantra');
  const cerebras = (cfg.get<string>('cerebrasApiKey') || '').trim();
  const groq = (cfg.get<string>('groqApiKey') || '').trim();
  const deep = (cfg.get<string>('deepgramApiKey') || '').trim();
  const aqua = (cfg.get<string>('aquavoiceApiKey') || '').trim();
  const effort = (cfg.get<string>('reasoningEffort') || 'low').trim();
  const provider = (cfg.get<string>('llmProvider') || 'groq').trim();

  if (cerebras) process.env.CEREBRAS_API_KEY = cerebras;
  if (groq) process.env.GROQ_API_KEY = groq;
  if (deep) process.env.DEEPGRAM_API_KEY = deep;
  if (aqua) process.env.AQUAVOICE_API_KEY = aqua;
  process.env.MANTRA_REASONING_EFFORT = effort;

  if (model) {
    model.setProvider(provider as any);
    if (groq) model.setGroqApiKey(groq);
    if (aqua) model.setAquavoiceApiKey(aqua);
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

  // --- Removed lines: inline "— N lines removed" tag near the anchor ---
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

  // --- Moved blocks: subtle left border + "moved from Lx–Ly" tag on first line ---
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
  const DISPOSE_MS = 5000;
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
  // Use trimmed version ONLY for fence detection, not for the final return.
  // Trimming would strip leading indentation which is critical in selection mode.
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

  // No fences found — return original with only trailing whitespace stripped,
  // preserving leading indentation (critical for selection-mode edits).
  return text.replace(/\s+$/, '');
}

// ─── Selection-mode helpers ─────────────────────────────────────────────────

/**
 * Replace only the selected range and highlight the changes.
 */
async function replaceSelectionWithHighlight(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  newText: string
): Promise<void> {
  // Expand to full lines for a clean replacement
  const doc = editor.document;
  const startLine = selection.start.line;
  const endLine = selection.end.line;
  const replaceRange = endLine < doc.lineCount - 1
    ? new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine + 1, 0))
    : new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, doc.lineAt(endLine).text.length));

  // Ensure new text ends with newline when replacing full lines (unless at end of file)
  let textToInsert = newText;
  if (endLine < doc.lineCount - 1 && !textToInsert.endsWith('\n')) {
    textToInsert += '\n';
  }

  await editor.edit((eb) => eb.replace(replaceRange, textToInsert));

  // Highlight the replaced region
  const insertedLines = textToInsert.split('\n');
  const lastInsertedLine = startLine + insertedLines.length - (textToInsert.endsWith('\n') ? 2 : 1);
  const highlightEnd = Math.min(Math.max(startLine, lastInsertedLine), doc.lineCount - 1);

  const addedType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.insertedForeground'),
  });
  const range = new vscode.Range(
    new vscode.Position(startLine, 0),
    editor.document.lineAt(highlightEnd).range.end
  );
  editor.setDecorations(addedType, [{ range }]);

  setTimeout(() => {
    try { editor.setDecorations(addedType, []); } finally { addedType.dispose(); }
  }, 5000);
}

async function ensureApiKeys(context: vscode.ExtensionContext): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('mantra');
  const commandsOnly = cfg.get<boolean>('commandsOnly', false);
  const sttProvider = (cfg.get<string>('sttProvider') || 'deepgram').trim();

  if (sttProvider === 'aquavoice') {
    // Aqua Voice (batch speech-to-text)
    if (!aquavoiceApiKey) {
      try { aquavoiceApiKey = (await context.secrets.get('AQUAVOICE_API_KEY')) || ''; } catch { }
      if (!aquavoiceApiKey && process.env.AQUAVOICE_API_KEY) { aquavoiceApiKey = process.env.AQUAVOICE_API_KEY; }
      if (!aquavoiceApiKey) {
        aquavoiceApiKey = await vscode.window.showInputBox({
          prompt: 'Enter your Aqua Voice API key',
          ignoreFocusOut: true,
          password: true,
        }) || '';
        if (!aquavoiceApiKey) {
          vscode.window.showWarningMessage('AQUAVOICE_API_KEY is required for Aqua Voice transcription.');
          return false;
        }
        await context.secrets.store('AQUAVOICE_API_KEY', aquavoiceApiKey);
      }
    }
  } else {
    // Deepgram (streaming speech-to-text)
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
  }

  // Ensure we have a model instance for STT even if LLM is off
  if (!model) {
    // NOTE: pass empty Cerebras key for now; we'll set it below if needed
    model = new Model('', deepgramApiKey);
  }
  if (sttProvider === 'aquavoice' && aquavoiceApiKey) {
    model.setAquavoiceApiKey(aquavoiceApiKey);
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
        e.affectsConfiguration('mantra.llmProvider') ||
        e.affectsConfiguration('mantra.deepgramApiKey') ||
        e.affectsConfiguration('mantra.aquavoiceApiKey') ||
        e.affectsConfiguration('mantra.sttProvider') ||
        e.affectsConfiguration('mantra.silenceTimeout') ||
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
          if (e.affectsConfiguration('mantra.aquavoiceApiKey')) {
            const newKey = (cfg.get<string>('aquavoiceApiKey') || '').trim();
            if (newKey) { aquavoiceApiKey = newKey; model.setAquavoiceApiKey(newKey); }
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

    const sttProvider = (vscode.workspace.getConfiguration('mantra').get<string>('sttProvider') || 'deepgram').trim();
    const isAquaVoice = sttProvider === 'aquavoice';
    console.log(`[Mantra] STT provider: ${isAquaVoice ? 'Aqua Voice (batch)' : 'Deepgram Flux (streaming)'}`);

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
      const provLabel = prov === 'groq' ? 'Groq' : 'Cerebras';
      sidebar?.postState({ listening: true, provider: provLabel, sttProvider });
    }

    // Volume metering → sidebar
    onVolume((level) => sidebar?.postState({ volume: level }));

    // Loop: mic → STT → final transcript → route → repeat
    while (!__mantraPaused) {
      try {
        await startMicStream(context, async (pcm) => {
          // Push mic name to sidebar (resolved inside startMicStream before this callback)
          sidebar?.postState({ mic: getMicName() });

          let transcript: string;

          if (isAquaVoice) {
            // Aqua Voice: buffer audio, detect silence, then send batch
            const silenceTimeoutSec = parseFloat(
              vscode.workspace.getConfiguration('mantra').get<string>('silenceTimeout') || '2'
            ) || 1.5;
            reportProgress?.('Recording... (speak, then pause to send)');
            transcript = await model!.transcribeBatch(pcm, (status) => {
              reportProgress?.(status);
            }, silenceTimeoutSec, () => __mantraPaused && !__stopAndTranscribe);
          } else {
            // Deepgram: stream audio with live transcription
            transcript = await model!.transcribeStream(pcm, (partial) => {
              if (partial) reportProgress?.(partial);
            });
          }

          // Reset notification after transcription completes
          reportProgress?.('Listening...');

          // If the user clicked Stop (not Stop & Transcribe), discard whatever came back
          if (__mantraPaused && !__stopAndTranscribe) {
            console.log('[Mantra] Stopped — discarding transcript');
            return;
          }

          if (!transcript) return;

          // Fix common Deepgram misrecognitions
          transcript = transcript.replace(/\bcodecs\b/gi, 'codex');
          transcript = transcript.replace(/\bdysfunction\b/gi, 'this function');
          transcript = transcript.replace(/\bdis function\b/gi, 'this function');

          // Secondary noise filter — catch anything the STT noise gate missed
          // In agent mode, allow yes/no/yeah/ok through (needed for permission prompts)
          const inAgent = isAgentModeActive();
          const NOISE_RE = inAgent
            ? /^(you|two|to|too|four|for|ate|eight|one|won|the|a|an|uh|um|oh|ah|hmm|huh|it|is|i|so|but|hey|hi|bye|hm|mm)\.?$/i
            : /^(you|two|to|too|four|for|ate|eight|one|won|the|a|an|uh|um|oh|ah|hmm|huh|it|is|i|so|but|yeah|yep|nah|no|yes|ok|hey|hi|bye|hm|mm)\.?$/i;
          if (NOISE_RE.test(transcript.trim())) {
            console.log('[Mantra] Secondary noise filter caught:', transcript);
            return;
          }

          // Junk phrase filter — phantom transcriptions from STT hallucinations
          const JUNK_PHRASES = [
            /subtitles\s+by\b/i,
            /amara\.org/i,
            /^thank\s*you\.?$/i,
            /^thanks\.?$/i,
            /^you're\s+welcome\.?$/i,
            /^bye[\s\-]*bye\.?$/i,
            /^good\s*(bye|night|morning)\.?$/i,
            /^please\s+subscribe\.?$/i,
            /^see\s+you\.?$/i,
          ];
          if (JUNK_PHRASES.some(re => re.test(transcript.trim()))) {
            console.log('[Mantra] Junk phrase filter caught:', transcript);
            return;
          }

          console.log('[Mantra] Transcript: ', transcript);
          sidebar?.postState({ lastTranscript: transcript });
          pushLog('transcript', transcript);

          // Aqua Voice: show completed transcript in bottom-right status bar
          if (isAquaVoice) {
            vscode.window.setStatusBarMessage(`\u201c${transcript}\u201d`, 5000);
          }

          // --- PAUSE/RESUME interception (pre-LLM) ---
          const t = transcript.trim().toLowerCase();
          if (/(^|\b)(pause|stop listening)(\b|$)/.test(t)) {
            vscode.window.showInformationMessage('Mantra stopped — use keyboard shortcut to resume');
            pushLog('command', 'Stopped listening');
            __mantraPaused = true;
            pauseRecording();
            return;
          }
          if (/(^|\b)(resume|start listening)(\b|$)/.test(t)) {
            // already running; fall through
          }

          // --- terminal execute / enter shortcut (pre-LLM) ---
          // Only when VS Code is focused — when unfocused, "enter" goes to trySystemCommand
          // which sends the keystroke to the frontmost app.
          // Use both t (raw) and tc (punctuation-stripped) — Flux often adds "."
          if (vscode.window.state.focused && /^(execute|execute that|run that|hit enter|press enter|submit|enter)\.?$/i.test(t)) {
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
            pushLog(getSelectedAgent() as LogEntry['kind'], `Interrupted ${getSelectedAgent()}`);
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

          // --- system-level commands (keyboard shortcuts, browser, window mgmt, keys, mouse, apps) ---
          // When VS Code is NOT focused, more commands route to System Events
          // (arrows, scroll, undo/copy/paste, etc. go to the frontmost app)
          const vscFocused = vscode.window.state.focused;
          if (await trySystemCommand(tc, vscFocused)) {
            pushLog('command', tc);
            return;
          }
          // "click" fallback for non-macOS (trySystemCommand handles macOS)
          if (process.platform !== 'darwin' && /^click$/i.test(tc)) {
            if (isAgentModeActive()) {
              confirmSelectedAgent();
            } else {
              executeLastTyped();
            }
            return;
          }

          // ── When VS Code is NOT focused, only allow agent interaction + focus switching ──
          // Don't run VS Code commands or LLM code modifications on other apps.
          if (!vscFocused) {
            // "ask/tell agent <prompt>"
            {
              const agentAskMatch = tc.match(/^(?:ask|tell|hey)\s+(?:codex|claude|agent|llm|ai|the\s+agent|the\s+llm)\b[,\s]*(.+)/i);
              if (agentAskMatch && agentAskMatch[1].trim()) {
                const prompt = agentAskMatch[1].replace(/^(uh|um|like|so|to|,)+\s*/i, '').trim();
                if (prompt) {
                  const agent = getSelectedAgent();
                  if (agent === 'none') {
                    vscode.window.showWarningMessage('No agent selected.');
                    pushLog('error', 'No agent selected');
                  } else if (isAgentModeActive()) {
                    typeInSelectedAgent(prompt);
                    pushLog(agent as LogEntry['kind'], prompt);
                  } else {
                    await sendToSelectedAgent(buildClaudePrompt(prompt));
                    pushLog(agent as LogEntry['kind'], prompt);
                  }
                  return;
                }
              }
            }
            // Focus commands: bring VS Code to front, then focus editor/terminal/agent
            if (/^(focus editor|go to editor|go to code|switch to editor|back to editor|back to code|focus terminal|go to terminal|switch to terminal|back to terminal|focus claude|switch to claude|go to claude|open claude|talk to claude|claude mode|focus codex|switch to codex|go to codex|open codex|talk to codex|codex mode|focus agent|switch to agent|go to agent|open agent|talk to agent|agent mode|focus llm|open llm|talk to llm|exit claude|leave claude|exit codex|leave codex|exit agent|leave agent|go back to editor)$/i.test(tc)) {
              // Bring VS Code to foreground first
              exec('open -a "Visual Studio Code"', () => {});
              await new Promise(r => setTimeout(r, 300));
              if (/editor|code|exit|leave|go back/i.test(tc)) {
                if (isClaudeMode()) setClaudeMode(false);
                if (isCodexMode()) setCodexMode(false);
                await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                pushLog('command', 'Focus editor');
              } else if (/terminal/i.test(tc)) {
                if (isClaudeMode()) setClaudeMode(false);
                if (isCodexMode()) setCodexMode(false);
                await vscode.commands.executeCommand('workbench.action.terminal.focus');
                pushLog('command', 'Focus terminal');
              } else {
                if (getSelectedAgent() === 'none') {
                  vscode.window.showWarningMessage('No agent selected.');
                  pushLog('error', 'No agent selected');
                } else {
                  await focusSelectedAgent();
                  pushLog('command', `Focus ${getSelectedAgent()}`);
                }
              }
              return;
            }
            // Everything else: don't run VS Code commands or LLM routing when not focused
            console.log(`[Mantra] VS Code not focused, ignoring: "${tc}"`);
            return;
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
          if (/^(focus editor|go to editor|go to code|switch to editor|back to editor|back to code|exit claude|leave claude|exit codex|leave codex|exit agent|leave agent|stop claude mode|stop codex mode|stop agent mode|go back to editor)$/i.test(tc)) {
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
                if (agent === 'none') {
                  vscode.window.showWarningMessage('No agent selected — select Claude Code or Codex in the sidebar to use agent mode.');
                  pushLog('error', 'No agent selected');
                } else if (isAgentModeActive()) {
                  typeInSelectedAgent(prompt);
                  pushLog(agent, prompt);
                } else {
                  await sendToSelectedAgent(buildClaudePrompt(prompt));
                  pushLog(agent, prompt);
                }
                return;
              }
            }
          }

          // --- enter agent mode explicitly (all names route to selected agent) ---
          if (/^(focus claude|switch to claude|go to claude|open claude|claude mode|talk to claude|focus codex|switch to codex|go to codex|open codex|codex mode|talk to codex|focus agent|switch to agent|go to agent|open agent|agent mode|talk to agent|focus llm|open llm|talk to llm)$/i.test(t)) {
            if (getSelectedAgent() === 'none') {
              vscode.window.showWarningMessage('No agent selected — select Claude Code or Codex in the sidebar.');
              pushLog('error', 'No agent selected');
            } else {
              await focusSelectedAgent();
              pushLog('command', `Focus ${getSelectedAgent()}`);
            }
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

          // --- selection model: determine scope before main routing ---
          // If user already has text selected, skip the selection model and
          // go straight to decide() which will activate SELECTION MODE.
          let scopeHighlight: vscode.TextEditorDecorationType | null = null;
          if (editor && editor.selection.isEmpty) {
            try {
              const scope = await model!.selectRange(transcript, {
                editor,
                filename: editor.document.fileName,
              });
              console.log('[Mantra] Selection model result:', scope);

              if (scope.action === 'select' && scope.startLine && scope.endLine) {
                // Pure selection command — select lines and stop
                const startPos = new vscode.Position(scope.startLine - 1, 0);
                const endLine = Math.min(scope.endLine - 1, editor.document.lineCount - 1);
                const endPos = new vscode.Position(endLine, editor.document.lineAt(endLine).text.length);
                editor.selection = new vscode.Selection(startPos, endPos);
                editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                pushLog('command', `Selected lines ${scope.startLine}–${scope.endLine}`);
                return;
              }

              if (scope.action === 'range' && scope.startLine && scope.endLine) {
                // Scoped modification — set selection and show gray highlight
                const startPos = new vscode.Position(scope.startLine - 1, 0);
                const endLine = Math.min(scope.endLine - 1, editor.document.lineCount - 1);
                const endPos = new vscode.Position(endLine, editor.document.lineAt(endLine).text.length);
                editor.selection = new vscode.Selection(startPos, endPos);

                // Show subtle gray highlight while the main model runs
                scopeHighlight = vscode.window.createTextEditorDecorationType({
                  isWholeLine: true,
                  backgroundColor: 'rgba(128, 128, 128, 0.12)',
                });
                editor.setDecorations(scopeHighlight, [{
                  range: new vscode.Range(startPos, endPos),
                }]);
                console.log('[Mantra] Scoped range: lines %d–%d', scope.startLine, scope.endLine);
              }
              // scope.action === 'full' → no selection, proceed normally
            } catch (err) {
              console.warn('[Mantra] Selection model error (proceeding with full):', err);
            }
          } else if (editor && !editor.selection.isEmpty) {
            console.log('[Mantra] Pre-existing selection detected — skipping selection model, using SELECTION MODE');
          }

          const commandsList = canonicalCommandPhrases();

          // --- decide + apply result ---
          const termHistory = getFullTerminalHistory();
          let result: any;
          try {
            const isQuickQ = /\bquick\s+question\b/i.test(transcript);
            result = await model!.decide(transcript, {
              editorContext,
              commands: commandsList,
              filename: editor?.document.fileName,
              editor: editor || undefined,
              terminalHistory: termHistory || undefined,
              agentBackend: isQuickQ ? 'none' : getSelectedAgent(),
            });
          } catch (err: any) {
            const status = (err && (err.status || err.code)) ?? 0;
            const isRate = status === 429 || /rate/i.test(String(err?.message || err));
            const provLabel = (vscode.workspace.getConfiguration('mantra').get<string>('llmProvider') || 'groq').trim();
            const msg = isRate
              ? `${provLabel} rate limit hit: ${String(err?.message || 'Too many requests')}`
              : `${provLabel} request failed: ${String(err?.message || err)}`;
            console.error('[Mantra] LLM error', err);
            if (outputChannel) {
              outputChannel.appendLine(`ERROR: ${msg}`);
              outputChannel.show(true);
            }
            vscode.window.showErrorMessage(msg);
            pushLog('error', msg);
            return;
          } finally {
            // Clear scope highlight once main model finishes
            if (scopeHighlight) {
              try { editor?.setDecorations(scopeHighlight, []); } catch {}
              scopeHighlight.dispose();
              scopeHighlight = null;
            }
          }

          // "Quick question" override — always force to question type so it's
          // answered locally, regardless of what the LLM chose.
          if (/\bquick\s+question\b/i.test(transcript)) {
            result = { ...result, type: 'question' as any };
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
              if (agent === 'none') {
                vscode.window.showWarningMessage('No agent selected — select Claude Code or Codex in the sidebar to use agent mode.');
                pushLog('error', 'No agent selected');
              } else if (isAgentModeActive()) {
                typeInSelectedAgent(prompt);
                pushLog(agent, prompt);
              } else {
                await sendToSelectedAgent(buildClaudePrompt(prompt));
                pushLog(agent, prompt);
              }
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
            } else if (result.selectionMode && !editor.selection.isEmpty) {
              // --- Selection mode: replace only the selected region ---
              const sel = editor.selection;
              const startLine = sel.start.line;
              const endLine = sel.end.line;
              const originalText = editor.document.getText(new vscode.Range(
                new vscode.Position(startLine, 0),
                new vscode.Position(endLine, editor.document.lineAt(endLine).text.length)
              ));
              const rawPayload = stripMarkdownCodeFence(result.payload ?? '');
              const filename = editor.document.fileName.split(/[\\/]/).pop() || 'file';
              const diff = makeUnifiedDiff(originalText, rawPayload, filename);

              const fullDocBefore = editor.document.getText();
              await replaceSelectionWithHighlight(editor, sel, rawPayload);
              const fullDocAfter = editor.document.getText();
              // Clear the blue text selection so it doesn't linger after the edit
              const newPos = new vscode.Position(startLine, 0);
              editor.selection = new vscode.Selection(newPos, newPos);

              vscode.window.setStatusBarMessage('Applied selection modification from LLM', 3000);
              const diffId = storeDiff(originalText, rawPayload, filename, fullDocBefore, fullDocAfter);
              pushLog('modification', `Modified selection in ${filename} (lines ${startLine + 1}–${endLine + 1})`, diff || undefined, diffId);
              // Immediately mark the new diff as undoable, then recheck all after a delay
              sidebar?.postState({ undoableDiffIds: [diffId] });
              setTimeout(() => notifyStaleDiffs(), 150);
            } else {
              const fullDocBefore = editor.document.getText();
              const newText = stripMarkdownCodeFence(result.payload ?? '');
              const filename = editor.document.fileName.split(/[\\/]/).pop() || 'file';
              const diff = makeUnifiedDiff(fullDocBefore, newText, filename);
              await replaceDocumentWithHighlight(editor, newText);
              const fullDocAfter = editor.document.getText();
              vscode.window.setStatusBarMessage('Applied modification from LLM', 3000);
              const diffId = storeDiff(fullDocBefore, newText, filename, fullDocBefore, fullDocAfter);
              pushLog('modification', `Modified ${filename}`, diff || undefined, diffId);
              // Immediately mark the new diff as undoable, then recheck all after a delay
              sidebar?.postState({ undoableDiffIds: [diffId] });
              setTimeout(() => notifyStaleDiffs(), 150);
            }
          } else {
            // "question" type — route to Quick Question panel or to agent.
            // Quick Question if: user said "quick question", OR no agent selected.
            // Otherwise: forward to the selected agent.
            const isQuickQuestion = /\bquick\s+question\b/i.test(transcript);
            const agent = getSelectedAgent();
            if (!isQuickQuestion && agent !== 'none') {
              // Route to the selected agent
              if (isAgentModeActive()) {
                typeInSelectedAgent(transcript);
              } else {
                await sendToSelectedAgent(buildClaudePrompt(transcript));
              }
              pushLog(agent as LogEntry['kind'], transcript);
            } else {
              // Quick Question mode — show answer in the output panel
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

      // Stop & Transcribe: pause after this iteration completes
      if (__stopAndTranscribe) {
        __stopAndTranscribe = false;
        __mantraPaused = true;
        vscode.window.showInformationMessage('Mantra stopped after transcribing.');
        break;
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
    vscode.window.showInformationMessage('Mantra stopped');
    console.log('Stopped');
  });

  const stopAndTranscribeDisposable = vscode.commands.registerCommand('mantra.stopAndTranscribe', () => {
    __stopAndTranscribe = true;
    pauseRecording();
  });

  const pttStartDisposable = vscode.commands.registerCommand('mantra.pttStart', () => {
    startPtt();
  });

  const pttStopDisposable = vscode.commands.registerCommand('mantra.pttStop', () => {
    stopPtt();
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
    const mics = enumerateMicrophones();

    type MicItem = vscode.QuickPickItem & { args: string };
    const items: MicItem[] = mics.map(m => ({
      label: m.label,
      args: m.args,
    }));

    if (items.length === 0) {
      vscode.window.showErrorMessage('No microphones found. Ensure audio permissions are granted and FFmpeg is installed.');
      return;
    }

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a microphone to use with Mantra',
      canPickMany: false,
      ignoreFocusOut: true,
    });
    if (!pick) return;

    const cfg = vscode.workspace.getConfiguration('mantra');
    await cfg.update('microphoneInput', pick.args, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`Mantra mic set: ${pick.label}`, 3000);
    sidebar?.postState({ mic: pick.label, micArgs: pick.args });
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

  const editAquavoiceCmd = vscode.commands.registerCommand(
    'mantra.editAquavoiceApiKey',
    () => vscode.commands.executeCommand('workbench.action.openSettings', '@id:mantra.aquavoiceApiKey')
  );

  context.subscriptions.push(openSettingsCmd, editCerebrasCmd, editGroqCmd, editDeepgramCmd, editAquavoiceCmd);

  // Track terminal command history for Claude context
  context.subscriptions.push(...initTerminalHistory());

  // Focus Claude Code sidebar panel (routes to selected agent)
  const focusClaudeDisposable = vscode.commands.registerCommand('mantra.focusClaude', () => {
    focusSelectedAgent();
  });

  // Focus Codex terminal (routes to selected agent)
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
    __selectedAgent = agent as 'claude' | 'codex' | 'none';
    const cfg = vscode.workspace.getConfiguration('mantra');
    cfg.update('agentBackend', agent, vscode.ConfigurationTarget.Global);
    console.log(`[Mantra] Agent backend changed to: ${agent}`);
    // Stop recording without transcribing when settings change
    if (__mantraSessionActive) {
      vscode.commands.executeCommand('mantra.pause');
    }

    if (agent === 'none') {
      // No agent — don't close anything, just update state
      sidebar?.postState({ agentBackend: agent, agentInstalled: true });
    } else {
      // Close the other agent's terminal to enforce mutual exclusivity
      if (agent === 'claude') {
        closeCodexTerminal();
      } else {
        closeClaudeTerminal();
      }

      // Check if the new agent is installed and push status to sidebar
      const installed = agent === 'claude' ? true : checkCliInstalled('codex');
      sidebar?.postState({ agentBackend: agent, agentInstalled: installed });
    }
  });

  // LLM provider change from sidebar
  sidebar.onProviderChange((provider) => {
    const cfg = vscode.workspace.getConfiguration('mantra');
    cfg.update('llmProvider', provider, vscode.ConfigurationTarget.Global);
    if (model) model.setProvider(provider as any);
    console.log(`[Mantra] LLM provider changed to: ${provider}`);
    // Stop recording without transcribing when settings change
    if (__mantraSessionActive) {
      vscode.commands.executeCommand('mantra.pause');
    }
  });

  // STT provider change from sidebar
  sidebar.onSttProviderChange((provider) => {
    const cfg = vscode.workspace.getConfiguration('mantra');
    cfg.update('sttProvider', provider, vscode.ConfigurationTarget.Global);
    console.log(`[Mantra] STT provider changed to: ${provider}`);
    // Stop recording without transcribing when settings change
    if (__mantraSessionActive) {
      vscode.commands.executeCommand('mantra.pause');
    }
  });

  // Silence timeout change from sidebar
  sidebar.onSilenceTimeoutChange((timeout) => {
    const cfg = vscode.workspace.getConfiguration('mantra');
    cfg.update('silenceTimeout', timeout, vscode.ConfigurationTarget.Global);
    console.log(`[Mantra] Silence timeout changed to: ${timeout}s`);
    // Stop recording without transcribing when settings change
    if (__mantraSessionActive) {
      vscode.commands.executeCommand('mantra.pause');
    }
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

  // Microphone change from sidebar dropdown
  sidebar.onMicChange((args) => {
    const cfg = vscode.workspace.getConfiguration('mantra');
    cfg.update('microphoneInput', args, vscode.ConfigurationTarget.Global);
    // Find the label for this args string
    const mics = enumerateMicrophones();
    const match = mics.find(m => m.args === args);
    const label = match ? match.label : 'Custom';
    sidebar?.postState({ mic: label, micArgs: args });
    vscode.window.setStatusBarMessage(`Mantra mic set: ${label}`, 3000);
    console.log(`[Mantra] Microphone changed to: ${label}`);
  });

  // Open full diff in a VS Code tab from sidebar
  sidebar.onOpenDiffTab((diffId) => {
    const data = diffStore.get(diffId);
    if (!data) {
      vscode.window.showWarningMessage('Diff data no longer available.');
      return;
    }
    const oldUri = vscode.Uri.from({ scheme: 'mantra-diff', path: `/old/${diffId}/${data.filename}` });
    const newUri = vscode.Uri.from({ scheme: 'mantra-diff', path: `/new/${diffId}/${data.filename}` });
    vscode.commands.executeCommand('vscode.diff', oldUri, newUri, `${data.filename} (before \u2194 after)`);
  });

  // Undo a diff from sidebar
  sidebar.onUndoDiff(async (diffId) => {
    const data = diffStore.get(diffId);
    if (!data) {
      vscode.window.showWarningMessage('Diff data no longer available.');
      return;
    }

    // Find the editor for this file
    const editor = vscode.window.visibleTextEditors.find(
      e => e.document.fileName.endsWith(data.filename) || e.document.fileName.split(/[\\/]/).pop() === data.filename
    );
    if (!editor) {
      vscode.window.showWarningMessage(`File "${data.filename}" is not open in an editor.`);
      sidebar?.postState({ staleDiffIds: [diffId] });
      return;
    }

    // Check if the undo is still valid (compare full document snapshot)
    if (!data.fullDocAfter || editor.document.getText() !== data.fullDocAfter) {
      vscode.window.showWarningMessage('Cannot undo: the file has been modified since this change.');
      sidebar?.postState({ staleDiffIds: [diffId] });
      return;
    }

    // Apply the undo — restore the full document to its state before the edit
    const restoreTo = data.fullDocBefore ?? data.oldText;
    await replaceDocumentWithHighlight(editor, restoreTo);
    vscode.window.setStatusBarMessage(`Undid change in ${data.filename}`, 3000);
    pushLog('command', `Undid change in ${data.filename}`);

    // Mark this diff as stale (it's been undone)
    sidebar?.postState({ staleDiffIds: [diffId] });

    // Check if any other diffs are now stale
    notifyStaleDiffs();
  });

  // Push-to-talk: shared logic for sidebar button and keyboard shortcut
  let pttRunning = false;

  async function startPtt(): Promise<void> {
    if (__mantraSessionActive || pttRunning) {
      if (__mantraSessionActive) {
        vscode.window.showWarningMessage('Stop the main recording first before using Push to Talk.');
      }
      return;
    }
    pttRunning = true;
    vscode.commands.executeCommand('setContext', 'mantra.pttActive', true);
    stopMicTest();

    if (!(await ensureApiKeys(context))) {
      pttRunning = false;
      vscode.commands.executeCommand('setContext', 'mantra.pttActive', false);
      sidebar?.postState({ pttActive: false });
      return;
    }
    sidebar?.postState({ pttActive: true });
    onVolume((level) => sidebar?.postState({ volume: level }));

    try {
      await startMicStream(context, async (pcm) => {
        sidebar?.postState({ mic: getMicName() });

        // Always use batch mode for PTT — user controls when to stop
        let transcript: string;
        const sttProvider = (vscode.workspace.getConfiguration('mantra').get<string>('sttProvider') || 'deepgram').trim();
        if (sttProvider === 'aquavoice') {
          transcript = await model!.transcribeBatch(pcm, undefined, 999);
        } else {
          transcript = await model!.transcribeStream(pcm);
        }

        if (!transcript) return;

        // Same filtering as main loop
        transcript = transcript.replace(/\bcodecs\b/gi, 'codex');
        transcript = transcript.replace(/\bdysfunction\b/gi, 'this function');
        transcript = transcript.replace(/\bdis function\b/gi, 'this function');

        const NOISE_RE = /^(you|two|to|too|four|for|ate|eight|one|won|the|a|an|uh|um|oh|ah|hmm|huh|it|is|i|so|but|yeah|yep|nah|no|yes|ok|hey|hi|bye|hm|mm)\.?$/i;
        if (NOISE_RE.test(transcript.trim())) return;

        const JUNK_PHRASES = [
          /subtitles\s+by\b/i, /amara\.org/i, /^thank\s*you\.?$/i, /^thanks\.?$/i,
          /^you're\s+welcome\.?$/i, /^bye[\s\-]*bye\.?$/i, /^good\s*(bye|night|morning)\.?$/i,
          /^please\s+subscribe\.?$/i, /^see\s+you\.?$/i,
        ];
        if (JUNK_PHRASES.some(re => re.test(transcript.trim()))) return;

        // Show transcript
        sidebar?.postState({ lastTranscript: transcript });
        pushLog('transcript', transcript);
        vscode.window.setStatusBarMessage(`\u201c${transcript}\u201d`, 5000);

        // Process through the same pipeline as the main loop
        // For PTT, we do simplified processing: pre-LLM shortcuts then LLM routing
        const t = transcript.trim().toLowerCase();
        const tc = t.replace(/[.,!?;:]+$/, '').trim();

        // Refocus the editor so commands like "undo" target the right pane
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');

        // System commands
        if (await trySystemCommand(tc, vscode.window.state.focused)) {
          pushLog('command', tc);
          return;
        }

        // Quick commands
        if (await handleTextCommand(tc, context) || await tryExecuteMappedCommand(tc)) {
          pushLog('command', tc);
          return;
        }

        // LLM routing
        const cfg = vscode.workspace.getConfiguration('mantra');
        const commandsOnly = cfg.get<boolean>('commandsOnly', false);
        if (commandsOnly) return;

        const editor = vscode.window.activeTextEditor;
        const editorContext = editor ? `File: ${editor.document.fileName}\nLanguage: ${editor.document.languageId}` : '';
        const commandsList = canonicalCommandPhrases();
        const filename = editor?.document.fileName.split(/[\\/]/).pop() || '';
        const termHistory = getFullTerminalHistory();

        const isQuickQ = /\bquick\s+question\b/i.test(transcript);
        let result = await model!.decide(transcript, {
          editorContext, commands: commandsList, filename: editor?.document.fileName, editor: editor ?? undefined,
          terminalHistory: termHistory || undefined,
          agentBackend: isQuickQ ? 'none' : getSelectedAgent(),
        });

        if (!result) return;

        // "Quick question" override (same as main loop)
        if (/\bquick\s+question\b/i.test(transcript)) {
          result = { ...result, type: 'question' as any };
        }

        pushLog(result.type as LogEntry['kind'], result.payload?.substring(0, 200) || transcript);

        // Apply result (same logic as main loop)
        if (result.type === 'terminal') {
          const shellCmd = (result.payload || '').trim();
          if (shellCmd) {
            const shouldWait = /\b(don'?t (run|execute)|but (wait|hold|don'?t)|and (wait|hold)|just type|type it|don'?t hit enter|wait)\b/i.test(transcript);
            if (shouldWait) { typeInTerminal(shellCmd); } else { executeInTerminal(shellCmd); }
          }
        } else if (result.type === 'claude' || result.type === 'codex' || result.type === 'agent') {
          const prompt = (result.payload || '').trim();
          if (prompt) {
            const agent = getSelectedAgent();
            if (agent !== 'none') {
              if (isAgentModeActive()) typeInSelectedAgent(prompt);
              else await sendToSelectedAgent(buildClaudePrompt(prompt));
            }
          }
        } else if (result.type === 'command') {
          const phrase = (result.payload || '').toString().trim();
          await handleTextCommand(phrase, context) || await tryExecuteMappedCommand(phrase);
        } else if (result.type === 'modification' && editor) {
          if (result.selectionMode && !editor.selection.isEmpty) {
            const sel = editor.selection;
            const startLine = sel.start.line;
            const endLine = sel.end.line;
            const originalText = editor.document.getText(new vscode.Range(
              new vscode.Position(startLine, 0),
              new vscode.Position(endLine, editor.document.lineAt(endLine).text.length)
            ));
            const rawPayload = stripMarkdownCodeFence(result.payload ?? '');
            const fname = editor.document.fileName.split(/[\\/]/).pop() || 'file';
            const diff = makeUnifiedDiff(originalText, rawPayload, fname);
            const fullDocBefore = editor.document.getText();
            await replaceSelectionWithHighlight(editor, sel, rawPayload);
            const fullDocAfter = editor.document.getText();
            const newPos = new vscode.Position(startLine, 0);
            editor.selection = new vscode.Selection(newPos, newPos);
            const diffId = storeDiff(originalText, rawPayload, fname, fullDocBefore, fullDocAfter);
            pushLog('modification', `Modified selection in ${fname} (lines ${startLine + 1}\u2013${endLine + 1})`, diff || undefined, diffId);
            sidebar?.postState({ undoableDiffIds: [diffId] });
            setTimeout(() => notifyStaleDiffs(), 150);
          } else {
            const fullDocBefore = editor.document.getText();
            const newText = stripMarkdownCodeFence(result.payload ?? '');
            const fname = editor.document.fileName.split(/[\\/]/).pop() || 'file';
            const diff = makeUnifiedDiff(fullDocBefore, newText, fname);
            await replaceDocumentWithHighlight(editor, newText);
            const fullDocAfter = editor.document.getText();
            const diffId = storeDiff(fullDocBefore, newText, fname, fullDocBefore, fullDocAfter);
            pushLog('modification', `Modified ${fname}`, diff || undefined, diffId);
            sidebar?.postState({ undoableDiffIds: [diffId] });
            setTimeout(() => notifyStaleDiffs(), 150);
          }
        } else if (result.type === 'question') {
          const answer = result.payload;
          if (outputChannel && answer) {
            const sep = '\u2500'.repeat(60);
            const time = new Date().toLocaleTimeString();
            outputChannel.appendLine(`[${time}] Q: ${transcript.trim()}`);
            outputChannel.appendLine((answer || '').trim());
            outputChannel.appendLine(sep);
            outputChannel.show(true);
          }
          pushLog('question', (answer || '').trim().substring(0, 200));
        }

        if (model && result) {
          model.updateMemory(transcript, result, termHistory || undefined)
            .then(() => sidebar?.postState({ memory: model!.getMemory() }))
            .catch(() => {});
        }
      });
    } catch (err: any) {
      console.error('[Mantra] PTT error:', err?.message || err);
    } finally {
      pttRunning = false;
      offVolume();
      vscode.commands.executeCommand('setContext', 'mantra.pttActive', false);
      sidebar?.postState({ pttActive: false, volume: 0 });
    }
  }

  function stopPtt(): void {
    pauseRecording();
  }

  sidebar.onPttStart(() => { startPtt(); });
  sidebar.onPttStop(() => { stopPtt(); });

  // Stop & Transcribe: force-transcribe current audio then pause
  sidebar.onStopAndTranscribe(() => {
    __stopAndTranscribe = true;
    pauseRecording(); // kills FFmpeg → stream ends → STT resolves with whatever it has
  });

  // Register virtual document provider for diff tab content
  const diffContentProvider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const parts = uri.path.split('/');
      // path: /side/id/filename
      const side = parts[1]; // 'old' or 'new'
      const id = parseInt(parts[2], 10);
      const data = diffStore.get(id);
      if (!data) return '';
      return side === 'old' ? data.oldText : data.newText;
    }
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('mantra-diff', diffContentProvider)
  );

  // Re-evaluate undo staleness when any document changes (e.g. user edits or Ctrl+Z)
  let staleDiffTimer: NodeJS.Timeout | null = null;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => {
      // Debounce to avoid firing on every keystroke
      if (staleDiffTimer) clearTimeout(staleDiffTimer);
      staleDiffTimer = setTimeout(() => notifyStaleDiffs(), 300);
    })
  );

  // Push initial state to sidebar
  {
    const cfg = vscode.workspace.getConfiguration('mantra');
    const agent = cfg.get<string>('agentBackend') || 'claude';
    const provider = cfg.get<string>('llmProvider') || 'groq';
    const stt = cfg.get<string>('sttProvider') || 'deepgram';
    const silenceTimeout = cfg.get<string>('silenceTimeout') || '2';
    const installed = agent === 'claude' ? true : checkCliInstalled('codex');
    const cmdOnly = cfg.get<boolean>('commandsOnly', false);
    const micArgs = cfg.get<string>('microphoneInput') || '';
    const availableMics = enumerateMicrophones();
    sidebar.postState({
      routerPrompt: cfg.get<string>('prompt') || '',
      memoryPrompt: cfg.get<string>('memoryPrompt') || '',
      selectionPrompt: cfg.get<string>('selectionPrompt') || '',
      agentBackend: agent,
      agentInstalled: installed,
      llmProvider: provider,
      sttProvider: stt,
      silenceTimeout,
      commandsOnly: cmdOnly,
      availableMics,
      micArgs,
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

  // Initialize PTT context for keybinding toggle
  vscode.commands.executeCommand('setContext', 'mantra.pttActive', false);

  // Add to subscriptions:
  context.subscriptions.push(
    startDisposable,
    pauseDisposable,
    stopAndTranscribeDisposable,
    pttStartDisposable,
    pttStopDisposable,
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