import Groq from 'groq-sdk';
import * as vscode from 'vscode';
import { createClient as createDeepgramClient } from '@deepgram/sdk';
import { canonicalCommandPhrases } from './commands';

export type ReqType = 'command' | 'modification' | 'question';

export const RESPONSE_MODEL = 'openai/gpt-oss-120b';

export type RouteResult = { type: ReqType; payload: string; raw: string };

export function parseLabeledPayload(raw: string): RouteResult {
  const s = (raw || '').trim();
  const fence = s.startsWith('```') ? s.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '') : s;
  let m = fence.match(/^\s*(question|command|modification)\b\s*([\s\S]*)$/i);
  if (!m) {
    const line = (fence.split(/\r?\n/).find(l => /^(question|command|modification)\b/i.test(l)) || '').trim();
    if (line) {
      m = line.match(/^(question|command|modification)\b\s*([\s\S]*)$/i) as RegExpMatchArray | null;
    }
  }
  const t = (m?.[1] || '').toLowerCase() as ReqType;
  const payload = (m?.[2] || '').replace(/^\s+/, '');
  const type: ReqType = (t === 'question' || t === 'command' || t === 'modification') ? t : 'question';
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
    'next tab', 'previous tab', 'move tab left', 'move tab right', 'split editor', 'toggle split layout',
    'toggle breakpoint', 'add breakpoint', 'remove breakpoint', 'enable breakpoint', 'disable breakpoint',
    'start debugging', 'stop debugging', 'restart debugging', 'continue', 'step over', 'step into', 'step out',
    'format document', 'format selection', 'organize imports', 'fix imports',
    'expand selection', 'shrink selection', 'delete line', 'duplicate line', 'join lines', 'transpose letters',
    'select all', 'select word', 'select line', 'move line up', 'move line down',
    'toggle comment', 'toggle block comment', 'toggle line comment'
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
  private groq: Groq | null = null;
  private deepgram: ReturnType<typeof createDeepgramClient> | null = null; // TODO see if outdated?
  private baseKeyterms: string[] = [];

  constructor(apiKey: string, deepgramApiKey?: string) {
    if (apiKey) {
      this.groq = new Groq({ apiKey });
    }
    if (deepgramApiKey) {
      this.deepgram = createDeepgramClient(deepgramApiKey);
    }
    this.baseKeyterms = seedKeytermsBase();
  }

  // NEW: let the extension inject the key later
  public setGroqApiKey(apiKey: string) {
    this.groq = apiKey ? new Groq({ apiKey }) : null;
  }

  // (optional but handy)
  public hasGroq(): boolean {
    return !!this.groq;
  }

  private async chatText(req: {
    messages: { role: 'user' | 'system' | 'assistant'; content: string }[];
    model: string;
    temperature?: number;
  }): Promise<string> {
    if (!this.groq) {
      const e: any = new Error('Groq API key missing');
      e.status = 401;
      e.provider = 'groq';
      throw e;
    }
    try {
      const res = await this.groq.chat.completions.create({
        model: req.model,
        temperature: req.temperature ?? 0,
        messages: req.messages,
        reasoning_effort: ((process.env.MANTRA_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'low'),
      });
      const choice = res?.choices?.[0];
      const content = choice?.message?.content ?? '';
      return (content || '').toString().trim();
    } catch (err: any) {
      const status = (err && (err.status || err.code)) ?? 0;
      const e: any = new Error(String(err?.message || err));
      e.status = status;
      e.provider = 'groq';
      throw e; // let the caller decide how to show this
    }
  }

  // Inside class Model
  async transcribeStream(
    input: NodeJS.ReadableStream,
    onInterim?: (partial: string) => void
  ): Promise<string> {
    const DG: any = await import('@deepgram/sdk');

    // Reuse an existing client if you stored it on `this`; otherwise, fall back to env
    const deepgramClient =
      (this as any)?.deepgram ?? DG.createClient(process.env.DEEPGRAM_API_KEY || '');

    // Prefer any caller-provided model override; default to nova-3
    const modelName: string = (this as any)?.sttModel || 'nova-3';

    // Build a right-sized keyterm list (<=100 terms, modest token budget)
    const keyterms = buildKeytermsFinal(this.baseKeyterms || []);

    return await new Promise<string>((resolve, reject) => {
      let finalTranscript = '';
      let settled = false;

      const safeResolve = (txt: string) => {
        if (settled) return;
        settled = true;
        try { connection?.close?.(); } catch { /* noop */ }
        resolve(txt);
      };
      const safeReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        try { connection?.close?.(); } catch { /* noop */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      // Read trailing silence (ms) from VS Code settings; default 1000ms, clamp to >=100ms
      const trailingMsCfg = Math.max(
        100,
        Number(vscode.workspace.getConfiguration('mantra').get<number>('trailingSilenceMs', 1000))
      );

      // Live STT socket options (raw 16kHz mono PCM)
      const liveOpts: Record<string, any> = {
        model: 'nova-3',
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        interim_results: true,
        smart_format: true,
        // ms of silence to end an utterance (Deepgram endpointing)
        endpointing: trailingMsCfg,
        // keep finalization guardrail a bit higher than endpointing
        utterance_end_ms: Math.max(1500, trailingMsCfg + 500),
      };

      // Send biasing terms:
      // - nova-3 uses `keyterm` (supports Streaming)
      // - other models fall back to `keywords` (Streaming-supported, accepts optional boosts)
      if (Array.isArray(keyterms) && keyterms.length) {
        if (/^nova-3/.test(modelName)) {
          // Array -> repeated ?keyterm=params
          liveOpts.keyterm = keyterms;
        } else {
          // Mild boost for non-nova-3 models
          liveOpts.keywords = keyterms.map(t => `${t}:2`);
        }
      }

      // Open the websocket
      const connection = deepgramClient.listen.live(liveOpts);

      // Surface socket errors
      connection.on(DG.LiveTranscriptionEvents.Error, (e: any) => safeReject(e));

      connection.on(DG.LiveTranscriptionEvents.Open, () => {
        // Pipe PCM chunks into the socket
        input.on('data', (chunk: Buffer) => {
          if (chunk && chunk.length) {
            try { connection.send(chunk); } catch { /* ignore backpressure hiccups */ }
          }
        });

        // When the stream ends, finalize this segment
        input.on('end', () => {
          try { connection.send(JSON.stringify({ type: 'Finalize' })); } catch { /* noop */ }
        });

        input.on('error', (err) => safeReject(err));

        let utterance = '';
        let lastTxt = '';
        let committed = '';

        let idleTimer: NodeJS.Timeout | null = null;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          // Finalize if we stop getting updates for a bit.
          idleTimer = setTimeout(() => {
            if (!settled && utterance.trim()) {
              finalTranscript = utterance.trim();
              safeResolve(finalTranscript);
            }
          }, Math.max(1200, trailingMsCfg + 200)); // small cushion past configured silence
        };

        const appendWithOverlap = (base: string, next: string) => {
          if (!base) return next;
          // longest suffix of base that is a prefix of next
          const max = Math.min(base.length, next.length);
          let k = 0;
          for (let i = max; i > 0; i--) {
            if (base.endsWith(next.slice(0, i))) { k = i; break; }
          }
          return base + next.slice(k);
        };

        connection.on(DG.LiveTranscriptionEvents.Transcript, (msg: any) => {
          const alt = msg?.channel?.alternatives?.[0];
          const txt = (alt?.transcript ?? '').trim();
          if (!txt) return;

          // Use Deepgram's semantics: replace interim, append only when is_final
          const isFinal = msg?.is_final === true;
          const isSpeechFinal = msg?.speech_final === true;

          if (isFinal) {
            // Commit this finalized segment and reset the per-segment buffer
            committed = committed ? appendWithOverlap(committed, txt) : txt;
            lastTxt = '';
            utterance = committed;
          } else {
            // Interim: replace the current segment preview (do NOT append)
            utterance = committed ? (txt ? `${committed} ${txt}` : committed) : txt;
            lastTxt = txt;
          }

          resetIdle();

          if (isSpeechFinal) {
            finalTranscript = utterance.trim();
            safeResolve(finalTranscript);
          } else if (onInterim) {
            onInterim(utterance);
          }
        });

        // If Deepgram closes the socket, resolve with whatever we have
        connection.on(DG.LiveTranscriptionEvents.Close, () => {
          if (!settled) safeResolve(finalTranscript || '');
        });
      });
    });
  }

  async decide(
    utterance: string,
    ctx: { editorContext: string; commands: string[]; filename?: string; editor?: vscode.TextEditor }
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

    const system = [
      systemBase,
      '',
      'Canonical command catalog (authoritative; choose ONLY from these when outputting type=command):',
      commandList || '- (none provided)'
    ].join('\n');
    const parts: string[] = [];
    parts.push('User utterance:');
    parts.push(utterance.trim());
    parts.push('');
    parts.push(editorCtx);
    parts.push('');
    parts.push(cursorCtxStr);
    parts.push('');
    parts.push(symbolCtxStr);
    parts.push('');
    parts.push(fullFileStr);
    const user = parts.join('\n');

    console.log('LLM prompt ready.')
    const raw = await this.chatText({
      model: RESPONSE_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    console.log('Received raw LLM response.')
    const parsed = parseLabeledPayload(raw);
    if (!parsed?.payload) {
      throw new RouteFormatError('Model returned no payload. Raw: ' + raw);
    }
    return parsed;
  }
}