import * as vscode from 'vscode';
import { startMicStream, pauseRecording, recorderActive } from './recorder';
import { Model } from './model';
import { canonicalCommandPhrases, tryExecuteMappedCommand } from './commands';
import { handleCommand as handleTextCommand } from './textOps';

let model: Model | null = null;
let groqApiKey: string = '';
let deepgramApiKey: string = '';
let outputChannel: vscode.OutputChannel | null = null;

// Track explicit pause state separate from recorder process state
let __mantraPaused = false;

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
  // Groq (chat)
  if (!groqApiKey) {
    try { groqApiKey = (await context.secrets.get('GROQ_API_KEY')) || ''; } catch { /* ignore */ }
    if (!groqApiKey) {
      groqApiKey = await vscode.window.showInputBox({
        prompt: 'Enter your Groq API key',
        ignoreFocusOut: true,
        password: true,
      }) || '';
      if (!groqApiKey) {
        vscode.window.showWarningMessage('GROQ_API_KEY is required.');
        return false;
      }
      await context.secrets.store('GROQ_API_KEY', groqApiKey);
    }
  }
  // Deepgram (speech-to-text)
  if (!deepgramApiKey) {
    try { deepgramApiKey = (await context.secrets.get('DEEPGRAM_API_KEY')) || ''; } catch { /* ignore */ }
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
  if (!model) model = new Model(groqApiKey, deepgramApiKey);
  return true;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Mantra extension activated!');

  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Mantra');
  }

  // Migrate legacy sensitivity settings: leadingSilenceMs and silenceDb are deprecated
  try {
    const cfg = vscode.workspace.getConfiguration('mantra');
    const hadLegacy = (cfg.get('leadingSilenceMs') !== undefined) || (cfg.get('silenceDb') !== undefined);
    if (hadLegacy) {
      await cfg.update('leadingSilenceMs', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('silenceDb', undefined, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        'Mantra updated: using only trailing silence (ms) for end-pointing. Old settings removed.'
      );
    }
  } catch { }

  const onboarded = context.globalState.get<boolean>('mantra.onboarded');
  if (!onboarded) {
    const pick = await vscode.window.showInformationMessage(
      'Set your stop detection (how long of a pause until Mantra knows your instruction is over)?',
      'Use Balanced',
      'Open Settings',
      'Skip'
    );
    if (pick === 'Use Balanced') {
      const cfg = vscode.workspace.getConfiguration('mantra');
      await cfg.update('trailingSilenceMs', 1000, vscode.ConfigurationTarget.Global);
      await cfg.update('leadingSilenceMs', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('silenceDb', undefined, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(
        'Balanced profile applied (trailing silence only). Legacy settings removed.',
        3000
      );
    } else if (pick === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'mantra.');
    }
    await context.globalState.update('mantra.onboarded', true);
  }

  const configureAudioDisposable = vscode.commands.registerCommand('mantra.configureListening', async () => {
    const presets = [
      { label: 'Conservative (no false stops)', detail: 'trailing 3000ms', v: { t: 3000 } },
      { label: 'Balanced (recommended)', detail: 'trailing 2000ms', v: { t: 2000 } },
      { label: 'Sensitive (fast stop)', detail: 'trailing 1000ms', v: { t: 1000 } },
      { label: 'Custom…', detail: 'Enter a trailing silence in milliseconds', v: { t: -1 } },
    ];
    const choice = await vscode.window.showQuickPick(presets, { placeHolder: 'Choose a listening profile' });
    if (!choice) return;

    let trailing = choice.v.t;
    if (trailing === -1) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter trailing silence (ms) to end an utterance',
        validateInput: (v) => (/^\d+$/.test(v) && Number(v) >= 100 ? null : 'Enter a number ≥ 100'),
        value: String(vscode.workspace.getConfiguration('mantra').get('trailingSilenceMs', 1000)),
      });
      if (!input) return;
      trailing = Number(input);
    }

    const cfg = vscode.workspace.getConfiguration('mantra');
    await cfg.update('trailingSilenceMs', trailing, vscode.ConfigurationTarget.Global);
    await cfg.update('leadingSilenceMs', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('silenceDb', undefined, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(
      `${choice.label} applied (trailing silence only). Legacy settings removed.`,
      3000
    );
  });

  const startDisposable = vscode.commands.registerCommand('mantra.start', async () => {
    __mantraPaused = false;
    if (recorderActive()) {
      vscode.window.showInformationMessage('Already listening.');
      console.log('Already listening, ignoring start');
      return;
    }
    if (!(await ensureApiKeys(context))) return;

    // Loop: mic → Deepgram stream → final transcript → route → repeat
    while (!__mantraPaused) {
      let reportFn: ((msg: string) => void) | undefined;
      let completeProgress: (() => void) | undefined;
      const progressDone = vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Listening...' },
        (progress) => {
          reportFn = (msg: string) => progress.report({ message: msg });
          return new Promise<void>((resolve) => { completeProgress = () => resolve(); });
        }
      );

      await startMicStream(context, async (pcm) => {
        // Stream directly to Deepgram; show interim in the same notification
        const transcript = await model!.transcribeStream(pcm, (partial) => {
          if (partial && reportFn) reportFn(partial);
        });

        if (completeProgress) completeProgress();
        await progressDone;

        if (!transcript) {
          console.log('Empty transcript, ignoring');
          return;
        }
        vscode.window.showInformationMessage('Transcribed: ' + transcript);
        console.log('Transcript: ', transcript);

        // --- PAUSE/RESUME interception (pre-LLM, highest priority) ---
        const t = (transcript || '').trim().toLowerCase();
        if (/(^|\b)(pause|stop listening)(\b|$)/.test(t)) {
          vscode.window.showInformationMessage('Pausing Mantra...use keyboard shortcut to resume');
          __mantraPaused = true;
          pauseRecording();
          return;
        }
        if (/(^|\b)(resume|start listening)(\b|$)/.test(t)) {
          // fall through, we are already running
        }

        // --- try mapped command first ---
        const maybeHandled = await tryExecuteMappedCommand(transcript);
        if (maybeHandled) return;
        if (await handleTextCommand(transcript, context)) return;

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
        let result: any;
        try {
          result = await model!.decide(transcript, {
            editorContext,
            commands: commandsList,
            filename: editor?.document.fileName,
            editor: editor || undefined,
          });
        } catch (err: any) {
          const status = (err && (err.status || err.code)) ?? 0;
          const isRate = status === 429 || /rate/i.test(String(err?.message || err));
          const msg = isRate
            ? `Groq rate limit hit: ${String(err?.message || 'Too many requests')}`
            : `Groq request failed: ${String(err?.message || err)}`;

          console.error('[Mantra] LLM error', err);
          if (outputChannel) {
            outputChannel.appendLine(`ERROR: ${msg}`);
            outputChannel.show(true);
          }
          vscode.window.showErrorMessage(msg);
          return;
        }

        if (result.type === 'command') {
          const phrase = (result.payload || '').toString().trim();
          const ok =
            (await handleTextCommand(phrase, context)) ||
            (await tryExecuteMappedCommand(phrase));
          if (!ok) vscode.window.showWarningMessage(`Unknown command: ${phrase}`);
        } else if (result.type === 'modification') {
          if (!editor) {
            vscode.window.showWarningMessage('No active editor for modification.');
          } else {
            const newText = stripMarkdownCodeFence(result.payload ?? '');
            await replaceDocumentWithHighlight(editor, newText);
            vscode.window.setStatusBarMessage('Applied modification from LLM', 3000);
          }
        } else {
          const answer = result.payload;
          if ((answer || '').toLowerCase().replace(/[^\w\s]/g, '').trim() === 'thank you') return;
          if (outputChannel && answer) {
            const sep = '─'.repeat(60);
            const time = new Date().toLocaleTimeString();
            const q = (transcript || '').trim();
            const a = (answer || '').trim();
            outputChannel.appendLine(`[${time}] Q: ${q}`);
            outputChannel.appendLine(a);
            outputChannel.appendLine(sep);
            outputChannel.show(true);
          } else {
            vscode.window.showInformationMessage(answer || '(no answer)');
          }
        }
      });

      // loop for the next utterance unless paused/stopped
      if (!recorderActive()) await new Promise(res => setTimeout(res, 25));
    }
  });

  const pauseDisposable = vscode.commands.registerCommand('mantra.pause', () => {
    __mantraPaused = true;
    pauseRecording();
    vscode.window.showInformationMessage('Mantra paused');
    console.log('Paused');
  });

  const resumeDisposable = vscode.commands.registerCommand('mantra.resume', () => {
    __mantraPaused = false;
    console.log('Resume requested');
    return vscode.commands.executeCommand('mantra.start');
  });

  const configurePromptDisposable = vscode.commands.registerCommand('mantra.configurePrompt', async () => {
  try {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'mantra.prompt');
  } catch (e) {
    console.log('Failed to open settings to mantra.prompt; opening Settings UI instead', e);
    await vscode.commands.executeCommand('workbench.action.openSettings');
  }
});

  // Add to subscriptions:
  context.subscriptions.push(
    startDisposable, pauseDisposable, resumeDisposable, configureAudioDisposable, configurePromptDisposable
  );
}

export function deactivate() {
  __mantraPaused = true;
  pauseRecording();
  console.log('Extension deactivated');
}