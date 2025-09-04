import * as vscode from 'vscode';
import * as path from 'path';
import { tryExecuteMappedCommand } from './commands';

/** Normalize a free-form utterance for matching. */
const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .replace(/[^\w\s\-./\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const digitsOnly = (s: string) => s.replace(/[,_]/g, '');

/** Active editor helper */
function activeEditor(): vscode.TextEditor | null {
  return vscode.window.activeTextEditor ?? null;
}

/** Spoken-number -> integer (supports simple phrases) */
function toIntMaybe(raw: string): number | null {
  const s = norm(raw);
  if (/^\d+$/.test(digitsOnly(s))) return parseInt(digitsOnly(s), 10);

  const UNITS: Record<string, number> = {
    'zero': 0, 'oh': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14,
    'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
  };
  const TENS: Record<string, number> = {
    'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
    'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
  };
  const SCALES: Record<string, number> = {
    'hundred': 100, 'thousand': 1000,
  };

  let total = 0, current = 0;
  for (const tok of s.split(/\s+/)) {
    if (UNITS.hasOwnProperty(tok)) current += UNITS[tok];
    else if (TENS.hasOwnProperty(tok)) current += TENS[tok];
    else if (SCALES.hasOwnProperty(tok)) { current *= SCALES[tok]; total += current; current = 0; }
    else if (tok === 'and') continue;
    else return null;
  }
  return total + current;
}

/** Convert a spoken filename phrase into a likely filename string. */
function spokenToFilename(raw: string): string {
  let s = (raw || '').toLowerCase().trim();

  // Phrase-level replacements
  const replacements: Array<[RegExp, string]> = [
    [/\bforward slash\b/g, '/'],
    [/\bback slash\b/g, '\\\\'],
    [/\bbackslash\b/g, '\\\\'],
    [/\bslash\b/g, '/'],
    [/\bperiod\b/g, '.'],
    [/\bpoint\b/g, '.'],
    [/\bdot\b/g, '.'],
    [/\bunderscore\b/g, '_'],
    [/\bunder score\b/g, '_'],
    [/\bdash\b/g, '-'],
    [/\bhyphen\b/g, '-'],
    [/\bspace\b/g, ' '],
    [/\bcolon\b/g, ':'],
  ];
  for (const [re, rep] of replacements) s = s.replace(re, rep);

  // Convert basic number words found outside of obvious decimals
  const numMap: Record<string, string> = {
    'zero': '0', 'oh': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
    'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10'
  };
  s = s.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (m) => numMap[m]);

  // Collapse spaces around punctuation we care about
  s = s.replace(/\s*([./\\_-])\s*/g, '$1');

  // Special handling: ". p y" -> ".py", ". t s" -> ".ts", etc.
  s = s.replace(/\.(?:\s*([a-z])(?:\s+|$))+?/g, (match) => {
    // grab letters after dots, remove spaces
    const letters = match.replace(/\./, '').replace(/\s+/g, '');
    return '.' + letters;
  });

  // Remove remaining spaces (filenames usually don't have them; safer for matching)
  s = s.replace(/\s+/g, '');

  return s;
}

/** Open the closest-matching file by name anywhere in the workspace (recursive).
 *  - Searches all workspace folders with vscode.workspace.findFiles.
 *  - Skips heavy directories (node_modules, .git, dist, out, build, etc.).
 *  - Caps the search for performance and notifies the user if the cap is reached.
 */
async function openClosestFileByName(targetRaw: string): Promise<boolean> {
  const spoken = (targetRaw || '').trim();
  if (!spoken) return false;

  const target = spokenToFilename(spoken);
  const lookedLikeFile =
    /[./\\]/.test(spoken) ||
    /\b(dot|period|point|underscore|dash|hyphen|slash|backslash)\b/i.test(spoken);
  const threshold = lookedLikeFile ? 0.45 : 0.70;

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    const ed = activeEditor();
    if (!ed || ed.document.uri.scheme !== 'file') {
      vscode.window.showWarningMessage('No workspace is open to search for files.');
      return false;
    }
  }

  // Hard cap to keep large monorepos responsive.
  const MAX_RESULTS = 5000;

  // Exclude common heavy dirs across languages.
  const EXCLUDE_GLOB: vscode.GlobPattern =
    '**/{node_modules,.git,dist,out,build,coverage,.next,.turbo,.cache,.venv,venv,__pycache__,target}/**';

  let uris: vscode.Uri[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Mantra: searching files…' },
    async () => {
      uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_RESULTS);
    }
  );

  if (uris.length === 0) {
    vscode.window.showWarningMessage('No files found in the workspace.');
    return false;
  }

  const capped = uris.length >= MAX_RESULTS;

  // --- Scoring helpers ---
  const editor = activeEditor();
  const activeUri = editor?.document?.uri?.scheme === 'file' ? editor.document.uri : undefined;
  const activeDir = activeUri ? path.dirname(activeUri.fsPath) : undefined;

  const targetBase = path.basename(target);
  const targetNoExt = targetBase.replace(/\.[^.]+$/, '');

  const simplify = (s: string) => (s || '').toLowerCase();
  const stripNonWord = (s: string) => simplify(s).replace(/[^a-z0-9]+/g, '');

  function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  }

  function proximityPenalty(candidateFsPath: string): number {
    if (!activeDir) return 0;
    try {
      const rel = path.relative(activeDir, candidateFsPath);
      // More path segments away = slightly worse (capped).
      const hops = rel.split(/[\\/]+/).filter(Boolean).length;
      return Math.min(0.10, hops * 0.01);
    } catch {
      return 0;
    }
  }

  type Scored = { uri: vscode.Uri; rel: string; base: string; score: number; };

  const scored: Scored[] = uris.map((uri) => {
    // Prefer workspace-relative path (prefix with folder name for multi-root).
    const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
    const rel = wsFolder
      ? `${wsFolder.name}/${vscode.workspace.asRelativePath(uri, false)}`
      : vscode.workspace.asRelativePath(uri, false);

    const base = path.basename(uri.fsPath);

    const baseNorm = stripNonWord(base);
    const relNorm = stripNonWord(rel);
    const tBaseNorm = stripNonWord(targetBase);
    const tNoExtNorm = stripNonWord(targetNoExt);

    let s = 0;

    // Strong signals first.
    if (simplify(base) === simplify(targetBase)) s = 1.0;
    else if (stripNonWord(path.parse(base).name) === tNoExtNorm) s = 0.98;
    else if (baseNorm.includes(tBaseNorm) || tBaseNorm.includes(baseNorm)) s = 0.92;
    else if (relNorm.includes(tBaseNorm)) s = 0.88;
    else {
      // Fuzzy on basename (0.60..1.00 range).
      const a = baseNorm, b = tBaseNorm;
      const dist = levenshtein(a, b);
      const sim = 1 - dist / Math.max(1, Math.max(a.length, b.length));
      s = 0.60 + 0.40 * sim;
    }

    // Tiny boost if extension matches when the target included one.
    const targetExt = path.extname(targetBase);
    if (targetExt && path.extname(base).toLowerCase() === targetExt.toLowerCase()) s += 0.02;

    // Slightly prefer files closer to the active file.
    s -= proximityPenalty(uri.fsPath);

    return { uri, rel, base, score: s };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (!best || best.score < threshold) {
    const where = folders && folders.length > 1 ? 'workspace' : 'folder';
    vscode.window.showWarningMessage(`Could not confidently find "${spoken}" in the ${where}.`);
    return false;
  }

  if (capped) {
    vscode.window.showInformationMessage(
      `Mantra: searched ${MAX_RESULTS.toLocaleString()} files (cap reached). ` +
      `Try a more specific phrase to narrow results.`
    );
  }

  const doc = await vscode.workspace.openTextDocument(best.uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  vscode.window.setStatusBarMessage(`Opened: ${best.rel}`, 1500);
  return true;
}

/** Jump to one-based line number */
function gotoLine(ed: vscode.TextEditor, n: number) {
  const line = clamp(n - 1, 0, ed.document.lineCount - 1);
  const pos = new vscode.Position(line, 0);
  const range = new vscode.Range(pos, pos);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Scroll viewport using built-in 'editorScroll'. */
async function scrollViewport(
  direction: 'up' | 'down',
  by: 'line' | 'page' | 'halfPage' | 'wrappedLine',
  amount = 1
) {
  await vscode.commands.executeCommand('editorScroll', {
    to: direction,
    by,
    value: clamp(Math.max(1, Math.floor(amount)), 1, 500),
    revealCursor: true,
  });
}

/** Selection helpers */
function selectLines(ed: vscode.TextEditor, a: number, b: number): vscode.Range {
  const start = clamp(Math.min(a, b) - 1, 0, ed.document.lineCount - 1);
  const end = clamp(Math.max(a, b) - 1, 0, ed.document.lineCount - 1);
  const range = new vscode.Range(
    new vscode.Position(start, 0),
    new vscode.Position(end, Number.MAX_SAFE_INTEGER)
  );
  ed.selection = new vscode.Selection(range.start, range.end);
  return range;
}

async function cutRangeToClipboard(ed: vscode.TextEditor, range: vscode.Range) {
  const text = ed.document.getText(range);
  await vscode.env.clipboard.writeText(text);
  await ed.edit(b => b.delete(range));
}

async function copyRangeToClipboard(ed: vscode.TextEditor, range: vscode.Range) {
  const text = ed.document.getText(range);
  await vscode.env.clipboard.writeText(text);
}

async function indentSelection(ed: vscode.TextEditor, outdent = false) {
  await vscode.commands.executeCommand(outdent ? 'editor.action.outdentLines' : 'editor.action.indentLines');
}
async function cutSelection(ed: vscode.TextEditor) {
  await vscode.commands.executeCommand('editor.action.clipboardCutAction');
}
async function copySelection(ed: vscode.TextEditor) {
  await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
}
async function pasteClipboard(ed: vscode.TextEditor) {
  await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
}

async function deleteSelection(ed: vscode.TextEditor) {
  const sel = ed.selection;
  if (!sel.isEmpty) await ed.edit(b => b.delete(sel));
}

/** MAIN ENTRY */
export async function handleCommand(utterance: string, _context?: vscode.ExtensionContext): Promise<boolean> {
  const s = norm(utterance);
  const ed = activeEditor();

  // paste (custom so we can round-trip our own clipboard)
  if (ed && /^paste$/i.test(s)) { await pasteClipboard(ed); return true; }

  // ---------- Highly-specific, parameterized ops first ----------

  // open <filename>  / open file <filename>  (supports spoken "dot p y")
  {
    const mOpen = s.match(/^open\s+(?:file\s+)?(.+)$/i);
    if (mOpen) {
      const spokenName = mOpen[1].trim();
      // Only treat as filename if it looks file-like OR the phrase included file punctuation words
      const looksFileLike = /[./\\]/.test(spokenName) || /\b(dot|period|point|underscore|dash|hyphen|slash|backslash)\b/i.test(spokenName);
      if (looksFileLike) {
        const ok = await openClosestFileByName(spokenName);
        if (ok) return true;
      }
    }
  }

  // go to line N / go to N
  {
    const m1 = s.match(/\b(?:go to|goto|jump to)\s+line\s+([a-z0-9 -]+)\b/);
    if (m1 && ed) {
      const n = toIntMaybe(m1[1]);
      if (n) { gotoLine(ed, n); return true; }
    }
    const m2 = s.match(/^(?:go to|goto|jump to)\s+([a-z0-9 -]+)$/);
    if (m2 && ed) {
      const n2 = toIntMaybe(m2[1]);
      if (n2) { gotoLine(ed, n2); return true; }
    }
    // bare "line 17" / "line number 17"
    const m3 = s.match(/^(?:line|line number)\s+([a-z0-9 -]+)\b/);
    if (m3 && ed) {
      const n3 = toIntMaybe(m3[1]);
      if (n3) { gotoLine(ed, n3); return true; }
    }
  }

  // go to top/bottom
  if (ed && /^(go to )?(top|start)$/.test(s)) { gotoLine(ed, 1); return true; }
  if (ed && /^(go to )?(bottom|end)$/.test(s)) { gotoLine(ed, ed.document.lineCount); return true; }

  // scroll up/down [N] (lines|pages|half page) | page up/down | scroll N (defaults to lines, down)
  {
    if (ed) {
      // "scroll to the top/bottom" (viewport only; keep cursor position)
      const mtb = s.match(/^scroll\s+to\s+(?:the\s+)?(top|bottom)$/);
      if (mtb) {
        const dir = mtb[1] === 'top' ? 'up' : 'down';
        await vscode.commands.executeCommand('editorScroll', {
          to: dir,
          by: 'page',
          value: 100000,
          revealCursor: false,
        });
        return true;
      }

      // bare "page up/down"
      const mp = s.match(/^page\s+(up|down)$/);
      if (mp) { await scrollViewport(mp[1] as 'up' | 'down', 'page', 1); return true; }

      // "scroll N" (no unit, defaults to lines, down)
      const mBare = s.match(/^scroll\s+([a-z0-9 -]+)$/);
      if (mBare) {
        const nBare = toIntMaybe(mBare[1]);
        if (nBare && nBare > 0) { await scrollViewport('down', 'line', nBare); return true; }
      }

      // Forms handled:
      //   "scroll up [by] N [lines|line|pages|page|half page]"
      //   "scroll [by] N [lines|line|pages|page|half page] down"
      //   "scroll down"  (defaults to 1 page)
      const m =
        s.match(/^scroll\s+(up|down)(?:\s+(?:by\s+)?([a-z0-9 -]+?))?(?:\s+(lines?|line|pages?|page|half\s+page))?$/) ||
        s.match(/^scroll\s+(?:by\s+)?([a-z0-9 -]+)\s*(lines?|line|pages?|page|half\s+page)\s+(up|down)$/);

      if (m) {
        let dir: 'up' | 'down';
        let numRaw = '';
        let unitRaw = '';

        if (m.length === 4 && (m[1] === 'up' || m[1] === 'down')) {
          // pattern 1: direction first
          dir = m[1] as 'up' | 'down';
          numRaw = (m[2] || '').trim();
          unitRaw = (m[3] || '').trim();
        } else {
          // pattern 2: amount/unit first, direction last
          numRaw = (m[1] || '').trim();
          unitRaw = (m[2] || '').trim();
          dir = (m[3] as 'up' | 'down');
        }

        // unit
        let by: 'line' | 'page' | 'halfPage' | 'wrappedLine' = 'page';
        const combo = `${numRaw} ${unitRaw}`.trim();
        if (/half\s*page/.test(combo)) by = 'halfPage';
        else if (/page/.test(unitRaw)) by = 'page';
        else if (/line/.test(unitRaw)) by = 'line';

        // amount
        let n = toIntMaybe(numRaw);
        if (!n || n < 1) n = 1;

        await scrollViewport(dir, by, n);
        return true;
      }

      // bare "scroll up/down" => one page
      if (/^scroll\s+(up|down)$/.test(s)) {
        const dir = (s.endsWith('up') ? 'up' : 'down') as 'up' | 'down';
        await scrollViewport(dir, 'page', 1);
        return true;
      }
    }
  }

  // lines A to B (select/copy/cut/delete)
  {
    const m = s.match(/\b(?:(select|copy|cut|delete)\s+)?lines?\s+([a-z0-9 -]+)\s+(?:to|through|-)\s+([a-z0-9 -]+)\b/);
    if (m && ed) {
      const [, op, aRaw, bRaw] = m;
      const a = toIntMaybe(aRaw); const b = toIntMaybe(bRaw);
      if (a && b) {
        const range = selectLines(ed, a, b);
        if (op === 'copy')      { await copyRangeToClipboard(ed, range); }
        else if (op === 'cut')  { await cutRangeToClipboard(ed, range); }
        else if (op === 'delete'){ await deleteSelection(ed); } // deleteSelection already edits directly
        return true;
      }
    }
  }

  // single-line select/copy/cut/delete
  {
    const m = s.match(/\b(?:(select|copy|cut|delete)\s+)?line\s+([a-z0-9 -]+)\b/);
    if (m && ed) {
      const [, op, numRaw] = m;
      const n = toIntMaybe(numRaw);
      if (n) {
        const range = selectLines(ed, n, n);
        if (op === 'copy')      { await copyRangeToClipboard(ed, range); }
        else if (op === 'cut')  { await cutRangeToClipboard(ed, range); }
        else if (op === 'delete'){ await deleteSelection(ed); }
        return true;
      }
    }
  }

    // new line (above|below)
    if (/^new\s+line$/.test(s)) { await vscode.commands.executeCommand('editor.action.insertLineAfter'); return true; }
    if (/^new\s+line\s+below$/.test(s)) { await vscode.commands.executeCommand('editor.action.insertLineAfter'); return true; }
    if (/^new\s+line\s+above$/.test(s)) { await vscode.commands.executeCommand('editor.action.insertLineBefore'); return true; }

    // indent / outdent
    if (ed && /^indent( lines?)?$/.test(s)) { await indentSelection(ed, false); return true; }
    if (ed && /^(outdent|dedent)( lines?)?$/.test(s)) { await indentSelection(ed, true); return true; }

    // ---------- Shared mapped commands (simple, parameterless) ----------
    if (await tryExecuteMappedCommand(utterance)) return true;

    // ---------- Let others handle ----------
    return false;
  }