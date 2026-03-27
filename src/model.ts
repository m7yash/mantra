import Cerebras from '@cerebras/cerebras_cloud_sdk';
import * as vscode from 'vscode';
import { canonicalCommandPhrases } from './commands';

export type ReqType = 'command' | 'modification' | 'question' | 'terminal' | 'claude' | 'codex' | 'agent';

export type LlmProvider = 'cerebras' | 'groq';

// Default models per provider
export const CEREBRAS_MODEL = 'gpt-oss-120b';
export const GROQ_MODEL_DEFAULT = 'openai/gpt-oss-120b';

export type RouteResult = { type: ReqType; payload: string; raw: string; selectionMode?: boolean };

export function parseLabeledPayload(raw: string): RouteResult {
  const s = (raw || '').trim();
  const fence = s.startsWith('```') ? s.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '') : s;
  const LABELS = 'question|command|modification|terminal|claude|codex|agent';
  // Capture EVERYTHING after the label word — do not eat spaces (they may be indentation)
  const labelRe = new RegExp(`^\\s*(${LABELS})\\b([\\s\\S]*)$`, 'i');
  const lineRe = new RegExp(`^(${LABELS})\\b`, 'i');
  let m = fence.match(labelRe);
  if (!m) {
    const line = (fence.split(/\r?\n/).find(l => lineRe.test(l)) || '').trim();
    if (line) {
      m = line.match(labelRe) as RegExpMatchArray | null;
    }
  }
  const t = (m?.[1] || '').toLowerCase() as ReqType;
  const rawPayload = m?.[2] || '';

  let payload: string;
  if (t === 'modification') {
    // For modifications: preserve indentation carefully.
    // Case 1: "modification\n    code" or "modification \n    code"
    //   → strip spaces on label line + newline → "    code" (indentation preserved)
    // Case 2: "modification    code" (same line, no newline)
    //   → strip only a single space separator → "   code" (best effort)
    const stripped = rawPayload.replace(/^[ \t]*\n/, '');
    if (stripped !== rawPayload) {
      // Had a newline — indentation is preserved
      payload = stripped;
    } else {
      // No newline — content on same line. Strip single space separator only.
      payload = rawPayload.replace(/^ /, '');
    }
  } else {
    // For non-modification types: strip all leading whitespace
    payload = rawPayload.replace(/^\s+/, '');
  }

  const VALID: Set<string> = new Set(['question', 'command', 'modification', 'terminal', 'claude', 'codex', 'agent']);
  const type: ReqType = VALID.has(t) ? t : 'question';
  return { type, payload, raw };
}

function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);
    Promise.resolve(p).then(
      v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      _ => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } },
    );
  });
}

async function getEnclosingSymbol(editor: vscode.TextEditor) {
  const symbols = await withTimeout(
    vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      editor.document.uri
    ),
    800
  );
  if (!symbols || !Array.isArray(symbols)) {
    console.log('[Mantra] symbol provider timed out or returned nothing.');
    return null;
  }
  const pos = editor.selection.active;

  function find(symList: vscode.DocumentSymbol[] | undefined): vscode.DocumentSymbol | null {
    if (!symList) return null;
    for (const s of symList) {
      if (s.range.contains(pos)) {
        const child = find(s.children);
        return child ?? s;
      }
    }
    return null;
  }

  const hit = find(symbols);
  if (!hit) return null;

  const range = new vscode.Range(hit.range.start, hit.range.end);
  const code = editor.document.getText(range);
  return {
    name: hit.name,
    kind: vscode.SymbolKind[hit.kind],
    range,
    code: code.length > 12000 ? code.slice(0, 12000) : code, // keep prompt tame
  };
}

function cursorSummary(editor: vscode.TextEditor) {
  const pos = editor.selection.active;
  const line1 = pos.line + 1;
  const col1 = pos.character + 1;
  const lineText = editor.document.lineAt(pos.line).text;
  const sel = editor.selection;
  const selectionText = sel.isEmpty ? '' : editor.document.getText(sel);
  return { line1, col1, lineText, selectionText };
}

export class RouteFormatError extends Error {
  constructor(msg: string) { super(msg); this.name = 'RouteFormatError'; }
}

const MAX_KEYTERMS = 100;
const MAX_TOKEN_APPROX = 500;

/** Language keywords (Python, Java, JavaScript, TypeScript). */
function languageKeywords(): string[] {
  const py = [
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
  ];
  const java = [
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null'
  ];
  const js = [
    'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'
  ];
  const ts = [
    'abstract', 'any', 'as', 'asserts', 'bigint', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue', 'declare', 'default', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'never', 'new', 'null', 'number', 'object', 'private', 'protected', 'public', 'readonly', 'require', 'return', 'satisfies', 'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unique', 'unknown', 'var', 'void', 'while', 'with', 'yield'
  ];
  return [...py, ...java, ...js, ...ts].map(s => s.toLowerCase());
}

/** Small language-aware vocab to bias code-y words. */
function codeVocabForLanguage(languageId: string | undefined): string[] {
  const common = [
    'print', 'for', 'range', 'length', 'len', 'if', 'elif', 'else', 'while',
    'function', 'def', 'class', 'return', 'variable', 'const', 'let',
    'import', 'export', 'async', 'await', 'try', 'except', 'catch',
    'comment', 'uncomment', 'rename', 'refactor', 'format', 'run'
  ];
  if (!languageId) return common;

  switch ((languageId || '').toLowerCase()) {
    case 'python':
      return Array.from(new Set([
        ...common,
        'def', 'class', 'list', 'dict', 'tuple', 'with', 'yield', 'pip'
      ]));
    case 'javascript':
    case 'typescript':
      return Array.from(new Set([
        ...common,
        'console log', 'console.log', 'require', 'npm', 'yarn', 'tsc'
      ]));
    case 'cpp':
    case 'c++':
      return Array.from(new Set([
        ...common,
        'std cout', 'std::cout', 'printf', 'include', 'namespace', 'using'
      ]));
    case 'java':
      return Array.from(new Set([
        ...common,
        'system out println', 'system.out.println', 'public static void main'
      ]));
    default:
      return common;
  }
}

/** Pull frequent identifiers from the active file to bias ASR toward in-file terms. */
function identifiersFromActiveEditor(max = 30): string[] {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return [];
  const text = ed.document.getText();
  const ids = (text.match(/[A-Za-z_][A-Za-z0-9_]{2,32}/g) || []).map(s => s.toLowerCase());
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .filter(k => !/^(the|and|with|from|true|false|null|class|def|function|return)$/.test(k))
    .slice(0, max);
  return sorted;
}

/** Rough token budget: count whitespace-separated words across phrases. */
function approxTokenCount(phrases: string[]): number {
  let total = 0;
  for (const p of phrases) total += (p.trim().split(/\s+/).filter(Boolean).length);
  return total;
}

/** Big, internal pool: language keywords + coding actions + IDE ops + CLI + natural phrases + variants. */
function seedKeytermsBase(): string[] {
  const set = new Set<string>();

  // 1) Language keywords
  for (const kw of languageKeywords()) set.add(kw);

  // 2) Coding verbs/targets combos
  const verbs = [
    'add', 'insert', 'append', 'prepend', 'remove', 'delete', 'erase', 'drop', 'strip',
    'replace', 'swap', 'rename', 'retitle', 'relabel',
    'move', 'shift', 'reorder', 'sort', 'group',
    'extract', 'inline', 'refactor', 'rebuild', 'rewrite', 'reorganize', 'optimize', 'simplify', 'clean up', 'deduplicate',
    'wrap', 'unwrap', 'surround', 'guard', 'check', 'validate', 'assert',
    'enable', 'disable', 'toggle',
    'comment', 'uncomment',
    'format', 'reformat', 'beautify', 'pretty print', 'align', 'indent', 'outdent',
    'run', 'execute', 'launch', 'start', 'stop', 'restart',
    'debug', 'profile', 'trace', 'benchmark',
    'compile', 'build', 'rebuild', 'test',
    'open', 'close', 'save', 'save all',
    'undo', 'redo', 'copy', 'paste', 'cut', 'duplicate',
    'search', 'find', 'find in files', 'replace in files',
    'fold', 'unfold', 'collapse', 'expand',
    'select', 'deselect', 'highlight',
    'go to', 'jump to', 'navigate to', 'peek',
    'generate', 'create', 'make', 'convert', 'transform', 'change',
    'documentation'
  ];
  const targets = [
    'line', 'lines', 'block', 'selection', 'file', 'files', 'folder', 'project', 'workspace',
    'variable', 'variables', 'constant', 'constants', 'parameter', 'parameters', 'argument', 'arguments',
    'function', 'functions', 'method', 'methods', 'class', 'classes', 'interface', 'enum', 'type alias', 'property', 'field',
    'loop', 'for loop', 'while loop', 'do while loop', 'if statement', 'else block', 'try catch', 'try finally',
    'import', 'exports', 'return statement', 'condition', 'expression', 'statement', 'docstring', 'comment',
    'constructor', 'getter', 'setter'
  ];
  for (const v of verbs) for (const t of targets) set.add(`${v} ${t}`);

  // 3) IDE/editor operations
  const ideOps = [
    'open file', 'new file', 'close file', 'save file', 'save all', 'reopen closed editor',
    'toggle sidebar', 'toggle panel', 'toggle terminal', 'toggle zen mode', 'toggle word wrap', 'toggle minimap',
    'show command palette', 'command palette', 'quick open', 'open recent', 'toggle explorer', 'focus explorer',
    'focus search', 'focus source control', 'focus debug', 'focus extensions', 'focus problems', 'focus output', 'focus terminal',
    'go to definition', 'peek definition', 'go to references', 'go to implementation', 'jump to bracket',
    'go to type definition', 'go to symbol', 'show hover', 'trigger suggest', 'autocomplete', 'accept suggestion',
    'next tab', 'previous tab', 'move tab left', 'move tab right', 'split editor', 'toggle split layout',
    'toggle breakpoint', 'add breakpoint', 'remove breakpoint', 'enable breakpoint', 'disable breakpoint',
    'start debugging', 'stop debugging', 'restart debugging', 'continue', 'step over', 'step into', 'step out',
    'format document', 'format selection', 'organize imports', 'fix imports',
    'expand selection', 'shrink selection', 'delete line', 'duplicate line', 'join lines', 'transpose letters',
    'select all', 'select word', 'select line', 'select current word', 'select current line',
    'select to end of line', 'select to start of line',
    'move to start of word', 'move to end of word', 'move to start of line', 'move to end of line',
    'move line up', 'move line down',
    'delete word', 'delete word forward', 'delete word backward',
    'toggle comment', 'toggle block comment', 'toggle line comment',
    'next error', 'previous error', 'next problem', 'previous problem',
    'next change', 'previous change', 'next diff', 'previous diff',
    'fold', 'unfold', 'fold all', 'unfold all', 'fold at cursor', 'unfold at cursor',
    'toggle fullscreen', 'show problems', 'show notifications', 'clear notifications', 'toggle breadcrumbs',
    'compare with saved', 'reveal in finder', 'copy file path', 'copy relative path',
    'markdown preview', 'toggle read only',
    'run task', 'run build task', 'run test task',
    'sort lines', 'sort lines ascending', 'sort lines descending',
    'uppercase', 'lowercase', 'title case', 'to upper', 'to lower', 'to title',
    'trim whitespace', 'trim trailing whitespace',
    'clear terminal', 'terminal scroll up', 'terminal scroll down',
    'terminal scroll to top', 'terminal scroll to bottom'
  ];
  for (const s of ideOps) set.add(s);

  // 4) File ops & CLI-ish
  const cliOps = [
    'open folder', 'create folder', 'make directory', 'remove directory', 'delete folder', 'rename folder',
    'copy file', 'move file', 'rename file', 'delete file',
    'list directory', 'change directory', 'clear terminal', 'new terminal', 'split terminal', 'kill terminal',
    'run build', 'run tests', 'start server', 'stop server', 'kill process', 'run program', 'compile project'
  ];
  for (const s of cliOps) set.add(s);

  // 4b) Git operations
  const gitOps = [
    'stage file', 'git stage', 'stage changes', 'git add', 'stage all', 'git stage all', 'git add all',
    'unstage file', 'git unstage', 'unstage changes',
    'commit', 'git commit', 'commit changes',
    'push', 'git push', 'push changes',
    'pull', 'git pull', 'pull changes',
    'checkout branch', 'git checkout', 'switch branch', 'change branch',
    'show diff', 'git diff', 'view diff',
    'stash', 'git stash', 'stash changes',
    'pop stash', 'git stash pop', 'unstash',
  ];
  for (const s of gitOps) set.add(s);

  // 4c) System / browser / window commands
  const systemTerms = [
    // browser navigation
    'go back', 'go forward', 'back', 'forward',
    'refresh', 'refresh page', 'hard refresh', 'reload',
    'new tab', 'close tab', 'reopen tab', 'reopen closed tab',
    'next tab', 'previous tab', 'last tab',
    'first tab', 'second tab', 'third tab', 'fourth tab', 'fifth tab',
    'tab one', 'tab two', 'tab three', 'tab four', 'tab five',
    'address bar', 'url bar', 'bookmark page', 'bookmark this',
    'dev tools', 'developer tools', 'inspect element', 'inspect',
    'open console', 'javascript console', 'view source', 'page source',
    // window / app management
    'open VS Code', 'open versus code', 'open IDE', 'open code',
    'open Visual Studio Code', 'switch to', 'click',
    'minimize', 'minimize window', 'close window',
    'full screen', 'next window', 'previous window',
    'hide app', 'show desktop', 'mission control',
    // mouse
    'move mouse', 'move cursor', 'click', 'double click', 'right click',
    // key simulation
    'press enter', 'press escape', 'press tab', 'press space',
    'press delete', 'press backspace',
    'press up', 'press down', 'press left', 'press right',
    'type', 'dictate',
    // terminal shortcuts
    'kill process', 'control c', 'control d', 'control z', 'control r',
    'control a', 'control e', 'control u', 'control w',
    'interrupt', 'clear terminal', 'reverse search', 'search history',
    'exit terminal', 'exit shell', 'clear line', 'delete word',
    'tab complete', 'run last command', 'repeat last command',
    // system utilities
    'spotlight', 'search computer', 'screenshot', 'take screenshot',
    'screenshot selection', 'lock screen',
    // scrolling & navigation
    'arrow up', 'arrow down', 'arrow left', 'arrow right',
    'scroll up', 'scroll down', 'scroll up a lot', 'scroll down a lot',
    'page up', 'page down', 'scroll to top', 'scroll to bottom',
    'up five times', 'down five times', 'up ten times', 'down ten times',
    'select all', 'select word', 'select line',
    'select to end', 'select to start',
    'zoom in', 'zoom out', 'reset zoom',
    // finder
    'show hidden files', 'go to folder', 'new folder',
  ];
  for (const s of systemTerms) set.add(s);

  // 4d) Mantra-specific terms — voice control keywords that must be recognized accurately
  const mantraTerms = [
    'Claude', 'ask Claude', 'tell Claude', 'hey Claude', 'focus Claude',
    'Codex', 'codex', 'ask Codex', 'tell Codex', 'hey Codex', 'focus Codex',
    'agent', 'ask agent', 'tell agent', 'hey agent', 'focus agent',
    'LLM', 'ask LLM', 'tell LLM', 'ask the LLM', 'ask AI',
    'execute that', 'run that', 'hit enter', 'press enter',
    'accept changes', 'reject changes', 'new conversation',
    'pause', 'resume', 'stop listening', 'start listening',
    'mantra',
    'this function', 'this class', 'this method', 'this block',
    'this loop', 'this if statement', 'this variable',
    'select this function', 'select this class', 'select this method',
  ];
  for (const s of mantraTerms) set.add(s);

  // 5) Natural language instruction patterns
  const patterns = [
    'change this to', 'convert this to', 'make this a', 'turn this into', 'rewrite this as',
    'replace x with y', 'replace this with', 'swap these two',
    'add error handling', 'add null check', 'add bounds check', 'add logging', 'add comment',
    'remove this line', 'remove this block', 'remove the print statement',
    'extract a function', 'extract method', 'inline variable', 'inline function',
    'split this function', 'merge these functions',
    'wrap this in an if', 'wrap this in try catch', 'wrap this in try finally', 'guard this with null check',
    'rename this variable to', 'rename this function to', 'rename this class to',
    'change the return type to', 'make this parameter optional', 'make this parameter required',
    'format the code', 'fix indentation', 'align these lines', 'sort these lines',
    'explain this code', 'write a docstring', 'generate documentation for this function'
  ];
  for (const s of patterns) set.add(s);

  // 6) Singleton codey tokens
  const singletons = [
    'print', 'console log', 'console.log', 'for', 'while', 'if', 'else', 'elif', 'range', 'len',
    'function', 'def', 'class', 'return', 'import', 'export', 'const', 'let', 'var', 'async', 'await', 'try', 'except', 'catch',
    'true', 'false', 'null', 'undefined', 'void', 'static', 'public', 'private', 'protected', 'readonly', 'override', 'abstract', 'interface', 'enum', 'type', 'keyof', 'infer'
  ];
  for (const s of singletons) set.add(s);

  // 7) Action-object variants
  const actions = ['add', 'remove', 'delete', 'insert', 'append', 'prepend', 'replace', 'rename', 'move', 'copy', 'cut', 'paste', 'duplicate', 'comment', 'uncomment', 'format', 'run', 'debug', 'build', 'test', 'compile', 'execute', 'start', 'stop', 'restart', 'toggle'];
  const objects = ['selection', 'current line', 'current file', 'current block', 'word', 'symbol', 'cursor line', 'this function', 'this class', 'this method', 'this loop', 'this condition', 'imports', 'document'];
  for (const a of actions) for (const o of objects) set.add(`${a} ${o}`);

  // 8) Navigation variants
  const navs = ['go to', 'jump to', 'navigate to', 'open', 'peek at', 'show'];
  const dests = ['definition', 'declaration', 'type definition', 'references', 'implementation', 'file', 'folder', 'symbol', 'next error', 'previous error', 'next warning', 'previous warning', 'line', 'column'];
  for (const n of navs) for (const d of dests) set.add(`${n} ${d}`);

  // 9) Loop conversions and condition phrases
  const loopForms = ['for loop', 'while loop', 'do while loop', 'for each loop'];
  const convActions = ['convert to', 'change to', 'turn into', 'rewrite as', 'refactor to', 'make it a'];
  for (const c of convActions) for (const l of loopForms) set.add(`${c} ${l}`);
  const conditionForms = ['if statement', 'if else', 'switch statement', 'ternary'];
  for (const c of conditionForms) { set.add(`add ${c}`); set.add(`wrap in ${c}`); }

  // 10) Parameterized rename-style phrases (kept moderate to avoid explosion)
  const subjects = ['variable', 'function', 'method', 'class', 'parameter', 'argument', 'property', 'field', 'module', 'file'];
  const ops2 = ['rename to', 'change name to', 'set name to', 'make it', 'set it to', 'change it to'];
  const names = ['result', 'output', 'count', 'index', 'value', 'item', 'element', 'data', 'buffer', 'temp', 'flag', 'config', 'handler', 'callback', 'state'];
  for (const subj of subjects) for (const op2 of ops2) for (const name of names) {
    if (set.size < 4000) set.add(`${subj} ${op2} ${name}`);
  }

  return Array.from(set);
}

/** Build final keyterms list with priorities and budgets. */
function buildKeytermsFinal(basePool: string[]): string[] {
  const set = new Set<string>();

  // 1) Big internal pool
  for (const t of basePool) set.add(t.toLowerCase());

  // 2) Canonical command phrases (high value)
  try {
    for (const c of canonicalCommandPhrases()) {
      const s = String(c).toLowerCase().trim();
      if (s) set.add(s);
    }
  } catch { /* ignore */ }

  // 3) Language-aware vocab
  for (const t of codeVocabForLanguage(vscode.window.activeTextEditor?.document.languageId)) {
    set.add(t.toLowerCase());
  }

  // 4) In-file identifiers (top N)
  for (const id of identifiersFromActiveEditor(30)) set.add(id);

  // Cap by count first
  let arr = Array.from(set);
  if (arr.length > MAX_KEYTERMS) arr = arr.slice(0, MAX_KEYTERMS);
  // Then enforce rough token budget
  while (approxTokenCount(arr) > MAX_TOKEN_APPROX && arr.length > 1) {
    arr.pop();
  }
  return arr;
}


export class Model {
  private cerebras: Cerebras | null = null;
  private groqApiKey: string = '';
  private deepgramApiKey: string = '';
  private aquavoiceApiKey: string = '';
  private baseKeyterms: string[] = [];
  private provider: LlmProvider = 'cerebras';
  private memory: string = '';

  constructor(apiKey: string, deepgramApiKey?: string) {
    if (apiKey) {
      this.cerebras = new Cerebras({ apiKey });
    }
    if (deepgramApiKey) {
      this.deepgramApiKey = deepgramApiKey;
    }
    this.baseKeyterms = seedKeytermsBase();
  }

  public setProvider(provider: LlmProvider) {
    this.provider = provider;
    console.log(`[Mantra] LLM provider set to: ${provider}`);
  }

  public setCerebrasApiKey(apiKey: string) {
    console.log('[Mantra] Setting Cerebras API key:', apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '(empty)');
    this.cerebras = apiKey ? new Cerebras({ apiKey }) : null;
  }

  public setGroqApiKey(apiKey: string) {
    console.log('[Mantra] Setting Groq API key:', apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '(empty)');
    this.groqApiKey = apiKey;
  }

  public setAquavoiceApiKey(apiKey: string) {
    console.log('[Mantra] Setting Aqua Voice API key:', apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '(empty)');
    this.aquavoiceApiKey = apiKey;
  }

  public hasLlm(): boolean {
    return this.provider === 'cerebras' ? !!this.cerebras : !!this.groqApiKey;
  }

  private async chatText(req: {
    messages: { role: 'user' | 'system' | 'assistant'; content: string }[];
    model: string;
    temperature?: number;
    reasoning_effort?: 'low' | 'medium' | 'high';
  }): Promise<string> {
    if (this.provider === 'groq') {
      return this.chatTextGroq(req);
    }
    return this.chatTextCerebras(req);
  }

  private async chatTextCerebras(req: {
    messages: { role: 'user' | 'system' | 'assistant'; content: string }[];
    model: string;
    temperature?: number;
    reasoning_effort?: 'low' | 'medium' | 'high';
  }): Promise<string> {
    if (!this.cerebras) {
      const e: any = new Error('Cerebras API key missing');
      e.status = 401;
      e.provider = 'cerebras';
      throw e;
    }
    const apiKey = (this.cerebras as any)?.apiKey ?? '(unknown)';
    console.log(`[Mantra] Cerebras request: model=${req.model}, key=${apiKey ? `${String(apiKey).slice(0, 8)}...${String(apiKey).slice(-4)}` : '(empty)'}`);
    try {
      const res = await this.cerebras.chat.completions.create({
        model: req.model,
        temperature: req.temperature ?? 0,
        messages: req.messages,
        reasoning_effort: req.reasoning_effort ?? ((process.env.MANTRA_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'low'),
      } as any);
      const timeInfo = (res as any)?.time_info;
      const completionTokens = (res as any)?.usage?.completion_tokens ?? 0;
      const completionTime = timeInfo?.completion_time ?? 0;
      const queueTime = timeInfo?.queue_time ?? 0;
      const tps = completionTime > 0 ? Math.round(completionTokens / completionTime) : 0;
      console.log(`[Mantra] Cerebras TPS: ${tps} (${completionTokens} tokens in ${completionTime.toFixed(2)}s, queue: ${queueTime.toFixed(2)}s)`);
      const choice = (res?.choices as any)?.[0];
      const content = choice?.message?.content ?? '';
      return (content || '').toString().trim();
    } catch (err: any) {
      const status = (err && (err.status || err.code)) ?? 0;
      const e: any = new Error(String(err?.message || err));
      e.status = status;
      e.provider = 'cerebras';
      throw e;
    }
  }

  private async chatTextGroq(req: {
    messages: { role: 'user' | 'system' | 'assistant'; content: string }[];
    model: string;
    temperature?: number;
    reasoning_effort?: 'low' | 'medium' | 'high';
  }): Promise<string> {
    if (!this.groqApiKey) {
      const e: any = new Error('Groq API key missing');
      e.status = 401;
      e.provider = 'groq';
      throw e;
    }
    const modelId = req.model || GROQ_MODEL_DEFAULT;
    console.log(`[Mantra] Groq request: model=${modelId}, key=${this.groqApiKey.slice(0, 8)}...${this.groqApiKey.slice(-4)}`);
    try {
      const startTime = Date.now();
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.groqApiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          temperature: req.temperature ?? 0,
          messages: req.messages,
          reasoning_effort: req.reasoning_effort ?? ((process.env.MANTRA_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'low'),
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        const e: any = new Error(`${resp.status} ${body || resp.statusText}`);
        e.status = resp.status;
        e.provider = 'groq';
        throw e;
      }
      const json: any = await resp.json();
      const elapsedSec = (Date.now() - startTime) / 1000;
      const completionTokens = json?.usage?.completion_tokens ?? 0;
      const tps = elapsedSec > 0 ? Math.round(completionTokens / elapsedSec) : 0;
      console.log(`[Mantra] Groq TPS: ${tps} (${completionTokens} tokens in ${elapsedSec.toFixed(2)}s)`);
      const content = json?.choices?.[0]?.message?.content ?? '';
      return (content || '').toString().trim();
    } catch (err: any) {
      if (err.provider === 'groq') throw err;
      const e: any = new Error(String(err?.message || err));
      e.status = (err && (err.status || err.code)) ?? 0;
      e.provider = 'groq';
      throw e;
    }
  }

  /**
   * Transcribe a PCM audio stream using Deepgram Flux (v2/listen).
   *
   * Flux is a conversational STT model with built-in end-of-turn detection.
   * It uses the v2 WebSocket endpoint and emits TurnInfo events with an
   * `event` field: StartOfTurn, Update, EndOfTurn, EagerEndOfTurn, TurnResumed.
   *
   * Auth via Authorization header (Node.js ws library).
   * 80ms audio chunks are recommended for optimal latency.
   */
  async transcribeStream(
    input: NodeJS.ReadableStream,
    onInterim?: (partial: string) => void
  ): Promise<string> {
    const WS = (await import('ws')).default;
    const dgKey = this.deepgramApiKey || process.env.DEEPGRAM_API_KEY || '';
    if (!dgKey) throw new Error('Deepgram API key not set');

    const keyterms = buildKeytermsFinal(this.baseKeyterms || []);

    // Build v2/listen URL — only params confirmed in Flux docs
    const params = new URLSearchParams({
      model: 'flux-general-en',
      encoding: 'linear16',
      sample_rate: '16000',
    });
    for (const kt of keyterms) params.append('keyterm', kt);

    const url = `wss://api.deepgram.com/v2/listen?${params.toString()}`;
    // Log URL without keyterms (they're long) for debugging
    console.log(`[Mantra] Connecting to Flux: wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000 (+${keyterms.length} keyterms)`);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let transcript = '';  // latest transcript from Flux

      // Auth via Authorization header (correct for Node.js ws library)
      const ws = new WS(url, {
        headers: { Authorization: `Token ${dgKey}` },
      });

      const NOISE_WORDS = new Set([
        // filler / ambient phantom words
        'the', 'a', 'an', 'and', 'uh', 'um', 'oh', 'ah', 'hmm', 'huh',
        'it', 'is', 'i', 'so', 'but', 'or', 'if', 'of', 'in', 'on',
        // numbers (common phantom detections from ambient noise)
        'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
        'nine', 'ten', 'to', 'too', 'for', 'ate', 'won',
        // other short filler (NOT yes/no/yeah/ok — those are intentional responses)
        'hey', 'hi', 'bye', 'hm', 'mm',
      ]);
      const isNoiseWord = (txt: string): boolean => {
        if (!txt || !txt.trim()) return true;  // empty = noise
        // Strip punctuation before checking (Flux may return "Two." or "Four,")
        const clean = txt.trim().replace(/[^a-zA-Z0-9\s]/g, '').trim().toLowerCase();
        if (!clean) return true;
        const words = clean.split(/\s+/);
        // Single noise word
        if (words.length === 1 && NOISE_WORDS.has(words[0])) return true;
        // Two noise words (e.g. "oh two", "uh huh")
        if (words.length === 2 && NOISE_WORDS.has(words[0]) && NOISE_WORDS.has(words[1])) return true;
        return false;
      };

      const safeResolve = (txt: string) => {
        if (settled) return;
        if (isNoiseWord(txt)) {
          console.log('[Mantra] Ignoring noise word:', txt);
          transcript = '';
          resetSafety();  // restart timer so we don't hang
          return;
        }
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        resolve(txt);
      };
      const safeReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      // Safety net: if Flux never fires EndOfTurn (e.g. only silence),
      // resolve after eot_timeout_ms (default 5000) + buffer.
      const EOT_SAFETY_MS = 8000;
      let safetyTimer: NodeJS.Timeout | null = null;
      const resetSafety = () => {
        if (safetyTimer) clearTimeout(safetyTimer);
        safetyTimer = setTimeout(() => {
          if (!settled) {
            console.log('[Mantra] Flux safety timeout — resolving with current transcript');
            safeResolve(transcript);
          }
        }, EOT_SAFETY_MS);
      };

      ws.on('unexpected-response', (_req: any, res: any) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          console.error(`[Mantra] Flux rejected: HTTP ${res.statusCode} — ${body}`);
          safeReject(new Error(`Deepgram returned ${res.statusCode}: ${body}`));
        });
      });

      ws.on('error', (e: any) => {
        console.error('[Mantra] Flux WebSocket error:', e?.message || e);
        safeReject(e);
      });

      ws.on('open', () => {
        console.log('[Mantra] Flux v2 WebSocket connected');
        resetSafety();

        // Pipe PCM audio into the WebSocket
        input.on('data', (chunk: Buffer) => {
          if (chunk && chunk.length && ws.readyState === WS.OPEN) {
            try { ws.send(chunk); } catch { /* ignore backpressure */ }
          }
        });

        // When mic stream ends, tell Flux to finalize
        input.on('end', () => {
          try {
            ws.send(JSON.stringify({ type: 'CloseStream' }));
          } catch { /* noop */ }
        });

        input.on('error', (err) => safeReject(err));
      });

      ws.on('message', (raw: Buffer | string) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Flux v2 messages are type "TurnInfo" with an event field
        const event: string = msg?.event ?? '';
        const txt: string = (msg?.transcript ?? '').trim();

        // Update transcript from every message that has one
        if (txt) {
          transcript = txt;
          resetSafety();
        }

        switch (event) {
          case 'StartOfTurn':
            console.log('[Mantra] Flux: StartOfTurn');
            break;

          case 'Update':
            // Interim transcript update — show in notification
            if (txt && onInterim) onInterim(transcript);
            break;

          case 'EndOfTurn': {
            console.log('[Mantra] Flux EndOfTurn:', transcript);
            if (transcript) safeResolve(transcript);
            break;
          }

          case 'EagerEndOfTurn':
            // Early speculative signal — log but wait for EndOfTurn
            console.log('[Mantra] Flux EagerEndOfTurn (confidence:', msg?.end_of_turn_confidence, ')');
            break;

          case 'TurnResumed':
            // User started speaking again after a pause — keep listening
            console.log('[Mantra] Flux: TurnResumed');
            break;

          default:
            // Unknown or no event — might be a system message
            break;
        }
      });

      ws.on('close', () => {
        console.log('[Mantra] Flux WebSocket closed');
        if (safetyTimer) clearTimeout(safetyTimer);
        if (!settled) safeResolve(transcript);
      });
    });
  }

  /**
   * Transcribe a complete PCM audio stream via Aqua Voice (batch HTTP POST).
   *
   * Buffers all PCM data from the stream, applies silence-based end-of-speech
   * detection, wraps the audio in a WAV container, and POSTs it to the
   * Aqua Voice Avalon API. Returns the final transcript.
   *
   * The stream is considered done when:
   *  - Silence (RMS < threshold) persists for SILENCE_TIMEOUT_MS after speech, OR
   *  - The input stream ends.
   */
  async transcribeBatch(
    input: NodeJS.ReadableStream,
    onStatus?: (status: string) => void,
    silenceTimeoutSec: number = 1.5,
    isCancelled?: () => boolean
  ): Promise<string> {
    const apiKey = this.aquavoiceApiKey || process.env.AQUAVOICE_API_KEY || '';
    if (!apiKey) throw new Error('Aqua Voice API key not set');

    // Collect PCM chunks, stop on silence after speech
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SAMPLE = 2; // 16-bit
    const SILENCE_THRESHOLD = 0.015; // RMS threshold for silence
    const SILENCE_TIMEOUT_MS = silenceTimeoutSec * 1000;
    const MIN_SPEECH_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 0.3; // at least 0.3s of audio before considering silence

    await new Promise<void>((resolve) => {
      let heardSpeech = false;
      let silenceStart: number | null = null;

      const checkSilence = (chunk: Buffer) => {
        const samples = Math.floor(chunk.length / BYTES_PER_SAMPLE);
        if (samples === 0) return;
        let sum = 0;
        for (let i = 0; i < samples; i++) {
          const s = chunk.readInt16LE(i * BYTES_PER_SAMPLE);
          sum += s * s;
        }
        const rms = Math.sqrt(sum / samples) / 32768;

        if (rms >= SILENCE_THRESHOLD) {
          heardSpeech = true;
          silenceStart = null;
        } else if (heardSpeech && totalBytes > MIN_SPEECH_BYTES) {
          if (!silenceStart) silenceStart = Date.now();
          else if (Date.now() - silenceStart >= SILENCE_TIMEOUT_MS) {
            console.log('[Mantra] Aqua Voice: silence detected, finalizing recording');
            input.removeAllListeners('data');
            resolve();
          }
        }
      };

      input.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        totalBytes += chunk.length;
        checkSilence(chunk);
      });

      input.on('end', () => resolve());
      input.on('error', () => resolve());
    });

    if (totalBytes < MIN_SPEECH_BYTES) {
      console.log('[Mantra] Aqua Voice: too little audio, skipping');
      return '';
    }

    // Check if recording was cancelled (user clicked Stop, not Stop & Transcribe)
    if (isCancelled?.()) {
      console.log('[Mantra] Aqua Voice: cancelled before API call, discarding audio');
      return '';
    }

    onStatus?.('Transcribing...');
    console.log(`[Mantra] Aqua Voice: sending ${(totalBytes / 1024).toFixed(1)}KB of audio`);

    // Build WAV file in memory
    const pcmData = Buffer.concat(chunks);
    const wavHeader = Buffer.alloc(44);
    const dataSize = pcmData.length;
    const fileSize = 36 + dataSize;
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(fileSize, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);       // fmt chunk size
    wavHeader.writeUInt16LE(1, 20);        // PCM format
    wavHeader.writeUInt16LE(1, 22);        // mono
    wavHeader.writeUInt32LE(SAMPLE_RATE, 24);
    wavHeader.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
    wavHeader.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
    wavHeader.writeUInt16LE(16, 34);       // bits per sample
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(dataSize, 40);
    const wavBuffer = Buffer.concat([wavHeader, pcmData]);

    // POST to Aqua Voice API as multipart/form-data
    const https = await import('https');
    const boundary = '----MantraBoundary' + Date.now().toString(36);
    const parts: Buffer[] = [];

    // file part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    ));
    parts.push(wavBuffer);
    parts.push(Buffer.from('\r\n'));

    // model part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\navalon-v1-en\r\n`
    ));

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const result = await new Promise<{ text?: string }>((resolve, reject) => {
      const req = https.request({
        hostname: 'api.aquavoice.com',
        path: '/api/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Aqua Voice API returned ${res.statusCode}: ${data}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON from Aqua Voice: ${data}`)); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const text = (result.text || '').trim();
    console.log('[Mantra] Aqua Voice transcript:', text);
    return text;
  }

  /**
   * Selection model: determines the scope (line range) for an utterance.
   * Returns 'select' (user wants to highlight code), 'range' (modify a region),
   * or 'full' (whole-file modification or non-modification).
   * Always uses the fast model with low reasoning effort.
   */
  async selectRange(
    utterance: string,
    ctx: {
      editor: vscode.TextEditor;
      filename?: string;
    }
  ): Promise<{ action: 'select' | 'range' | 'full'; startLine?: number; endLine?: number }> {
    const doc = ctx.editor.document;
    const pos = ctx.editor.selection.active;

    // Build numbered file content
    const whole = doc.getText();
    const lines = whole.split('\n');
    const MAX_CHARS = 100000;
    let numbered = '';
    for (let i = 0; i < lines.length; i++) {
      const line = `${i + 1}: ${lines[i]}\n`;
      if (numbered.length + line.length > MAX_CHARS) {
        numbered += `[truncated at line ${i + 1}]\n`;
        break;
      }
      numbered += line;
    }

    const selInfo = ctx.editor.selection.isEmpty
      ? ''
      : `Current selection: lines ${ctx.editor.selection.start.line + 1}–${ctx.editor.selection.end.line + 1}`;

    const user = [
      `Voice command: "${utterance}"`,
      `Cursor: line ${pos.line + 1}, column ${pos.character + 1}`,
      selInfo,
      `File: ${ctx.filename || '(unknown)'}`,
      `Language: ${doc.languageId}`,
      `Total lines: ${doc.lineCount}`,
      '',
      numbered,
    ].filter(Boolean).join('\n');

    const cfg = vscode.workspace.getConfiguration('mantra');
    const selectionPrompt = (cfg.get<string>('selectionPrompt') ?? '').trim();

    const selModel = this.provider === 'groq' ? GROQ_MODEL_DEFAULT : CEREBRAS_MODEL;

    try {
      const raw = await this.chatText({
        model: selModel,
        temperature: 0,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: selectionPrompt },
          { role: 'user', content: user },
        ],
      });
      console.log('[Mantra] Selection model raw:', raw);

      const trimmed = (raw || '').trim().toLowerCase();
      const m = trimmed.match(/^(select|range)\s+(\d+)\s+(\d+)/);
      if (m) {
        const startLine = Math.max(1, Math.min(parseInt(m[2], 10), doc.lineCount));
        const endLine = Math.max(startLine, Math.min(parseInt(m[3], 10), doc.lineCount));
        return { action: m[1] as 'select' | 'range', startLine, endLine };
      }
      return { action: 'full' };
    } catch (err) {
      console.warn('[Mantra] Selection model failed (falling back to full):', err);
      return { action: 'full' };
    }
  }

  async decide(
    utterance: string,
    ctx: {
      editorContext: string;
      commands: string[];
      filename?: string;
      editor?: vscode.TextEditor;
      terminalHistory?: string;
      agentBackend?: 'claude' | 'codex' | 'none';
    }
  ): Promise<RouteResult> {
    console.log('Entering decide function')

    // Safety net
    const commandsOnly = vscode.workspace.getConfiguration('mantra').get<boolean>('commandsOnly', false);
    if (commandsOnly) {
      return { type: 'command', payload: (utterance || '').trim(), raw: `command ${(utterance || '').trim()}` };
    }

    const commandList = (ctx.commands || []).map(c => `${c}`).join(', ');
    const editorCtx = `Editor context:\n${ctx.editorContext || '(none)'}\n${ctx.filename ? 'Filename: ' + ctx.filename : ''}`;

    // Cursor + enclosing symbol context if editor available
    let cursorCtxStr = '(no cursor info)';
    let symbolCtxStr = '(no enclosing symbol)';
    let fullFileStr = '(no full file available)';
    if (ctx.editor) {
      try {
        const cur = cursorSummary(ctx.editor);
        cursorCtxStr =
          [
            `Cursor summary:`,
            `- line: ${cur.line1}, column: ${cur.col1}`,
            `- line text: ${cur.lineText}`,
            `- selection: ${cur.selectionText ? cur.selectionText : '(none)'}`
          ].join('\n');
        console.log('[Mantra] cursor context ready');

        const enc = await getEnclosingSymbol(ctx.editor);
        console.log('[Mantra] symbol context %s', enc ? 'hit' : 'miss/timeout');
        if (enc) {
          const startLine = enc.range.start.line + 1;
          const startCol = enc.range.start.character + 1;
          const endLine = enc.range.end.line + 1;
          const endCol = enc.range.end.character + 1;
          symbolCtxStr =
            [
              `Enclosing symbol:`,
              `- name: ${enc.name}`,
              `- kind: ${enc.kind}`,
              `- range: [${startLine}:${startCol} - ${endLine}:${endCol}]`,
              `- code (truncated to 100000):`,
              '```',
              enc.code,
              '```'
            ].join('\n');
        }
        const MAX_CHARS = 100000;
        const whole = ctx.editor.document.getText();
        const truncated = whole.length > MAX_CHARS
          ? `${whole.slice(0, MAX_CHARS)}\n/* [truncated ${whole.length - MAX_CHARS} chars] */`
          : whole;
        fullFileStr = ['Full file contents (entire document):', '```', truncated, '```'].join('\n');
        console.log('[Mantra] full file captured');
      } catch (e) { console.log('[Mantra] pre-LLM context error (ignored)', e); }
    }

    const cfg = vscode.workspace.getConfiguration('mantra');
    const configuredPrompt = (cfg.get<string>('prompt') ?? '').trim();
    const systemBase = configuredPrompt;

    const agentName = ctx.agentBackend === 'claude' ? 'Claude Code' : ctx.agentBackend === 'codex' ? 'Codex' : null;
    const agentNote = agentName
      ? `\nIMPORTANT — An AI agent (${agentName}) is active. Prefer "agent" over "modification" for anything non-trivial. Use "modification" ONLY for small, targeted single-file edits (rename a variable, change a loop type, add a single line, remove a comment, etc.). For anything that requires thought, planning, multi-step work, new features, refactoring, or is even slightly complex, use "agent". When ambiguous, default to "agent". NEVER use "question" to answer something the agent could handle — "question" is ONLY for quick factual answers when no agent is available or the user explicitly asks a brief knowledge question like "what does this line do?".`
      : `\nNo AI agent is active. Use "question" for non-code queries and "modification" for code changes.`;

    const system = [
      systemBase,
      agentNote,
      '',
      'Canonical command catalog (authoritative; choose ONLY from these when outputting type=command):',
      commandList || '- (none provided)'
    ].join('\n');
    const parts: string[] = [];

    // Include conversation memory if available
    if (this.memory) {
      parts.push('Conversation memory (context from earlier in this session):');
      parts.push(this.memory);
      parts.push('');
    }

    parts.push('User utterance:');
    parts.push(utterance.trim());
    parts.push('');
    parts.push(editorCtx);
    parts.push('');
    parts.push(cursorCtxStr);
    parts.push('');
    parts.push(symbolCtxStr);
    parts.push('');

    // Include terminal history if available
    if (ctx.terminalHistory) {
      parts.push('Terminal history (recent commands and output):');
      parts.push(ctx.terminalHistory);
      parts.push('');
    }

    parts.push(fullFileStr);

    // --- Selection mode: if user has text selected, instruct LLM to output only the replacement ---
    let isSelectionMode = false;
    if (ctx.editor && !ctx.editor.selection.isEmpty) {
      const sel = ctx.editor.selection;
      const doc = ctx.editor.document;
      // Expand to full lines
      const startLine = sel.start.line;
      const endLine = sel.end.line;
      const selectedText = doc.getText(new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, doc.lineAt(endLine).text.length)
      ));
      const selLines = selectedText.split('\n');
      // Compute base indentation (minimum indent of non-empty lines)
      let baseIndent = '';
      let minLen = Infinity;
      for (const line of selLines) {
        if (line.trim() === '') continue;
        const indent = (line.match(/^(\s*)/) ?? ['', ''])[1];
        if (indent.length < minLen) { minLen = indent.length; baseIndent = indent; }
      }
      // Context: a few lines before and after
      const ctxBefore = startLine > 0
        ? doc.getText(new vscode.Range(
            new vscode.Position(Math.max(0, startLine - 3), 0),
            new vscode.Position(startLine, 0)
          )).trimEnd()
        : '(start of file)';
      const ctxAfter = endLine < doc.lineCount - 1
        ? doc.getText(new vscode.Range(
            new vscode.Position(endLine + 1, 0),
            new vscode.Position(Math.min(doc.lineCount - 1, endLine + 3), doc.lineAt(Math.min(doc.lineCount - 1, endLine + 3)).text.length)
          )).trimEnd()
        : '(end of file)';
      const indentDesc = baseIndent.length === 0 ? 'no indentation'
        : baseIndent.includes('\t') ? `${baseIndent.length} tab(s)`
        : `${baseIndent.length} spaces`;

      parts.push('');
      parts.push('⚠️ SELECTION MODE ⚠️');
      parts.push(`The user has lines ${startLine + 1}–${endLine + 1} selected. For a modification, output ONLY the replacement for the selected text — do NOT output the entire file. The full file above is for context only.`);
      parts.push('');
      parts.push(`Selected text (lines ${startLine + 1}–${endLine + 1}, to be replaced):`);
      parts.push('```');
      parts.push(selectedText);
      parts.push('```');
      parts.push('');
      parts.push('Context before selection:');
      parts.push('```');
      parts.push(ctxBefore);
      parts.push('```');
      parts.push('');
      parts.push('Context after selection:');
      parts.push('```');
      parts.push(ctxAfter);
      parts.push('```');
      parts.push('');
      parts.push(`CRITICAL OUTPUT FORMAT FOR SELECTION MODE:`);
      parts.push(`Your response MUST look exactly like this (the code goes on the NEXT line after the label):`);
      parts.push(`modification`);
      parts.push(`<replacement code with exact indentation>`);
      parts.push(``);
      parts.push(`CRITICAL INDENTATION RULES:`);
      parts.push(`1. The selected text uses ${indentDesc} as its base indentation ("${baseIndent}").`);
      parts.push(`2. Every line of your replacement MUST start with EXACTLY the same whitespace as the corresponding original line.`);
      parts.push(`3. Do NOT strip or reduce indentation. Do NOT add extra indentation. Copy the whitespace character-for-character.`);
      parts.push(`4. The FIRST line of your output must start with "${baseIndent}" — not at column 0.`);
      parts.push(`Example: if the selected text is:`);
      parts.push(`        if x > 0:`);
      parts.push(`            print(x)`);
      parts.push(`Then your output must also start each line with 8 spaces — never less.`);

      isSelectionMode = true;
      console.log('[Mantra] Selection mode active: lines %d-%d', startLine + 1, endLine + 1);
    }

    const user = parts.join('\n');

    const activeModel = this.provider === 'groq' ? GROQ_MODEL_DEFAULT : CEREBRAS_MODEL;
    console.log('LLM prompt ready.')
    const raw = await this.chatText({
      model: activeModel,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    console.log('Received raw LLM response.')
    const parsed = parseLabeledPayload(raw);
    if (!parsed?.payload) {
      if (isSelectionMode) {
        // In selection mode, empty payload after a valid label means "delete the selection"
        if (parsed.type === 'modification') {
          console.log('[Mantra] Selection mode: empty modification payload (deletion)');
          parsed.payload = '';
        } else if (raw.trim()) {
          // LLM skipped the label entirely — strip any accidental label prefix and use as modification
          console.log('[Mantra] Selection mode fallback: treating raw response as modification');
          parsed.type = 'modification';
          const stripped = raw.trim().replace(/^(question|command|modification|terminal|agent)\s*/i, '');
          parsed.payload = stripped;
        } else {
          throw new RouteFormatError('Model returned no payload. Raw: ' + raw);
        }
      } else {
        throw new RouteFormatError('Model returned no payload. Raw: ' + raw);
      }
    }
    if (isSelectionMode) parsed.selectionMode = true;
    return parsed;
  }

  /**
   * After a decide() call, update the running conversation memory.
   * Sends the current memory + latest interaction to the LLM and stores the updated summary.
   * This runs in the background and does not block the main flow.
   */
  async updateMemory(utterance: string, result: RouteResult, terminalHistory?: string): Promise<void> {
    try {
      const activeModel = this.provider === 'groq' ? GROQ_MODEL_DEFAULT : CEREBRAS_MODEL;
      const raw = await this.chatText({
        model: activeModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: (vscode.workspace.getConfiguration('mantra').get<string>('memoryPrompt') ?? '').trim(),
          },
          {
            role: 'user',
            content: [
              'Current memory:',
              this.memory || '(empty — this is the first interaction)',
              '',
              'Latest interaction:',
              `User said: "${utterance}"`,
              `Action taken: ${result.type}`,
              `Result: ${result.payload.length > 1000 ? result.payload.slice(0, 1000) + '...' : result.payload}`,
              '',
              terminalHistory ? `Recent terminal activity:\n${terminalHistory}` : '',
            ].filter(Boolean).join('\n'),
          },
        ],
      });
      this.memory = (raw || '').trim();
      console.log(`[Mantra] Memory updated (${this.memory.length} chars)`);
    } catch (err) {
      console.warn('[Mantra] Memory update failed (non-fatal):', err);
    }
  }

  /** Get the current conversation memory. */
  getMemory(): string { return this.memory; }

  /** Set the conversation memory (e.g. user edited it). */
  setMemory(text: string): void { this.memory = text; }
}