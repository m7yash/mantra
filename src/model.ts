import Cerebras from '@cerebras/cerebras_cloud_sdk';
import * as vscode from 'vscode';

export type ReqType = 'command' | 'modification' | 'question' | 'terminal' | 'claude' | 'agent';

export type LlmProvider = 'cerebras' | 'groq';

// Default models per provider
export const CEREBRAS_MODEL = 'qwen-3-235b-a22b-instruct-2507';
export const GROQ_MODEL_DEFAULT = 'moonshotai/kimi-k2-instruct';

// Models that require /no_think appended to user messages to suppress reasoning
const NO_THINK_MODELS = new Set([
  'qwen-3-235b-a22b-instruct-2507',
  'qwen/qwen3-32b',
]);

// Models that support the reasoning_effort parameter (only GPT-OSS variants)
const REASONING_EFFORT_MODELS = new Set([
  'gpt-oss-120b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-safeguard-20b',
]);

export type RouteResult = { type: ReqType; payload: string; raw: string; selectionMode?: boolean };

// Module-level: prevent AssemblyAI concurrent-session errors (1008)
let _aaiActiveWs: any = null;          // currently open WS (if any)
let _aaiLastCloseTime = 0;             // timestamp of last WS close
const AAI_SESSION_COOLDOWN_MS = 3000;  // minimum gap between sessions

export function parseLabeledPayload(raw: string): RouteResult {
  const s = (raw || '').trim();
  const fence = s.startsWith('```') ? s.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '') : s;
  const LABELS = 'question|command|modification|terminal|claude|agent';
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

  const VALID: Set<string> = new Set(['question', 'command', 'modification', 'terminal', 'claude', 'agent']);
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

export class Model {
  private cerebras: Cerebras | null = null;
  private groqApiKey: string = '';
  private deepgramApiKey: string = '';
  private aquavoiceApiKey: string = '';
  private assemblyaiApiKey: string = '';
  private provider: LlmProvider = 'cerebras';
  private llmModel: string = '';
  private memory: string = '';

  constructor(apiKey: string, deepgramApiKey?: string) {
    if (apiKey) {
      this.cerebras = new Cerebras({ apiKey });
    }
    if (deepgramApiKey) {
      this.deepgramApiKey = deepgramApiKey;
    }
  }

  public setProvider(provider: LlmProvider) {
    this.provider = provider;
    console.log(`[Mantra] LLM provider set to: ${provider}`);
  }

  public setModel(modelId: string) {
    this.llmModel = modelId;
    console.log(`[Mantra] LLM model set to: ${modelId || '(default)'}`);
  }

  public getModel(): string {
    if (this.llmModel) return this.llmModel;
    return this.provider === 'groq' ? GROQ_MODEL_DEFAULT : CEREBRAS_MODEL;
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

  public setAssemblyaiApiKey(apiKey: string) {
    console.log('[Mantra] Setting AssemblyAI API key:', apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '(empty)');
    this.assemblyaiApiKey = apiKey;
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
    // Suppress thinking/reasoning for models that support it
    if (NO_THINK_MODELS.has(req.model)) {
      // Append /no_think to the last user message for Qwen models
      const msgs = req.messages.map((m, i) => {
        if (m.role === 'user' && i === req.messages.length - 1) {
          return { ...m, content: m.content + '\n\n/no_think' };
        }
        return m;
      });
      req = { ...req, messages: msgs };
    }
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
      const cerebrasParams: any = {
        model: req.model,
        temperature: req.temperature ?? 0,
        messages: req.messages,
      };
      if (REASONING_EFFORT_MODELS.has(req.model)) {
        cerebrasParams.reasoning_effort = req.reasoning_effort ?? ((process.env.MANTRA_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'low');
      }
      const res = await this.cerebras.chat.completions.create(cerebrasParams);
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
          ...(REASONING_EFFORT_MODELS.has(modelId) ? {
            reasoning_effort: req.reasoning_effort ?? ((process.env.MANTRA_REASONING_EFFORT as 'low' | 'medium' | 'high') || 'low'),
          } : {}),
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

    const keyterms = identifiersFromActiveEditor(50);

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
            // Resolve directly — don't go through safeResolve which would loop on noise words
            settled = true;
            try { ws.close(); } catch { /* noop */ }
            resolve(transcript);
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
        if (!settled) {
          // WS is gone — must resolve now even if transcript is empty/noise.
          // safeResolve would loop via resetSafety on noise words, so bypass it.
          settled = true;
          resolve(transcript);
        }
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
    isCancelled?: () => boolean,
    sensitivity: string = 'medium'
  ): Promise<string> {
    const apiKey = this.aquavoiceApiKey || process.env.AQUAVOICE_API_KEY || '';
    if (!apiKey) throw new Error('Aqua Voice API key not set');

    // Collect PCM chunks, stop on silence after speech
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SAMPLE = 2; // 16-bit
    // Sensitivity: low = needs louder speech (noisy env), high = picks up quiet speech
    const SILENCE_THRESHOLD = sensitivity === 'low' ? 0.03 : sensitivity === 'high' ? 0.005 : 0.015;
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
   * Transcribe a complete PCM audio stream via AssemblyAI (batch HTTP POST).
   *
   * Buffers all PCM data from the stream, applies silence-based end-of-speech
   * detection (same as Aqua Voice), uploads audio, submits a transcription job
   * using Universal 3 Pro, and polls until complete.
   */
  async transcribeBatchAssemblyAI(
    input: NodeJS.ReadableStream,
    onStatus?: (status: string) => void,
    silenceTimeoutSec: number = 1.5,
    isCancelled?: () => boolean,
    sensitivity: string = 'medium'
  ): Promise<string> {
    const apiKey = this.assemblyaiApiKey || process.env.ASSEMBLYAI_API_KEY || '';
    if (!apiKey) throw new Error('AssemblyAI API key not set');

    // Collect PCM chunks, stop on silence after speech (same logic as Aqua Voice)
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const SAMPLE_RATE = 16000;
    const BYTES_PER_SAMPLE = 2;
    const SILENCE_THRESHOLD = sensitivity === 'low' ? 0.03 : sensitivity === 'high' ? 0.005 : 0.015;
    const SILENCE_TIMEOUT_MS = silenceTimeoutSec * 1000;
    const MIN_SPEECH_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 0.3;

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
            console.log('[Mantra] AssemblyAI batch: silence detected, finalizing recording');
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
      console.log('[Mantra] AssemblyAI batch: too little audio, skipping');
      return '';
    }

    if (isCancelled?.()) {
      console.log('[Mantra] AssemblyAI batch: cancelled before API call, discarding audio');
      return '';
    }

    onStatus?.('Uploading audio...');
    console.log(`[Mantra] AssemblyAI batch: uploading ${(totalBytes / 1024).toFixed(1)}KB of audio`);

    // Build WAV file in memory
    const pcmData = Buffer.concat(chunks);
    const wavHeader = Buffer.alloc(44);
    const dataSize = pcmData.length;
    const fileSize = 36 + dataSize;
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(fileSize, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(1, 22);
    wavHeader.writeUInt32LE(SAMPLE_RATE, 24);
    wavHeader.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
    wavHeader.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    wavHeader.writeUInt16LE(16, 34);
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(dataSize, 40);
    const wavBuffer = Buffer.concat([wavHeader, pcmData]);

    // Step 1: Upload audio to AssemblyAI
    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: wavBuffer,
    });
    if (!uploadResp.ok) {
      const body = await uploadResp.text().catch(() => '');
      throw new Error(`AssemblyAI upload failed: ${uploadResp.status} ${body}`);
    }
    const uploadJson: any = await uploadResp.json();
    const audioUrl = uploadJson.upload_url;
    if (!audioUrl) throw new Error('AssemblyAI upload returned no URL');

    // Step 2: Submit transcription job with Universal 3 Pro
    onStatus?.('Transcribing...');
    const submitResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        speech_models: ['universal-3-pro'],
        keyterms_prompt: identifiersFromActiveEditor(100),
      }),
    });
    if (!submitResp.ok) {
      const body = await submitResp.text().catch(() => '');
      throw new Error(`AssemblyAI transcript submit failed: ${submitResp.status} ${body}`);
    }
    const submitJson: any = await submitResp.json();
    const transcriptId = submitJson.id;
    if (!transcriptId) throw new Error('AssemblyAI returned no transcript ID');

    // Step 3: Poll for completion
    const POLL_INTERVAL_MS = 800;
    const MAX_POLL_MS = 60000;
    const pollStart = Date.now();
    while (Date.now() - pollStart < MAX_POLL_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const pollResp = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { 'Authorization': apiKey },
      });
      if (!pollResp.ok) continue;
      const pollJson: any = await pollResp.json();

      if (pollJson.status === 'completed') {
        const text = (pollJson.text || '').trim();
        console.log('[Mantra] AssemblyAI batch transcript:', text);
        return text;
      }
      if (pollJson.status === 'error') {
        throw new Error(`AssemblyAI transcription failed: ${pollJson.error || 'unknown error'}`);
      }
      // status is 'queued' or 'processing' — keep polling
    }

    throw new Error('AssemblyAI transcription timed out after 60s');
  }

  /**
   * Transcribe a PCM audio stream using AssemblyAI Universal-3 Pro Streaming (v3/ws).
   *
   * Uses the v3 WebSocket endpoint with the u3-rt-pro speech model.
   * Turn messages with end_of_turn=true signal the final transcript.
   * ForceEndpoint is sent when the mic stream ends to flush the final turn.
   * Auth via Authorization header.
   */
  async transcribeStreamAssemblyAI(
    input: NodeJS.ReadableStream,
    onInterim?: (partial: string) => void
  ): Promise<string> {
    const WS = (await import('ws')).default;
    const apiKey = this.assemblyaiApiKey || process.env.ASSEMBLYAI_API_KEY || '';
    if (!apiKey) throw new Error('AssemblyAI API key not set');

    const t0 = Date.now();
    const log = (msg: string) => console.log(`[Mantra] AAI +${Date.now() - t0}ms: ${msg}`);

    // Force-close any lingering WS from a previous session that didn't shut down
    if (_aaiActiveWs) {
      log('Force-closing lingering WS from previous session');
      try {
        if (_aaiActiveWs.readyState === 1 /* OPEN */) {
          _aaiActiveWs.send(JSON.stringify({ type: 'Terminate' }));
        }
        _aaiActiveWs.terminate(); // hard kill — don't wait for graceful handshake
      } catch { /* noop */ }
      _aaiActiveWs = null;
      await new Promise(r => setTimeout(r, 1500));
    }

    // Enforce cooldown between sessions so AssemblyAI releases the slot
    const sinceLast = Date.now() - _aaiLastCloseTime;
    if (_aaiLastCloseTime > 0 && sinceLast < AAI_SESSION_COOLDOWN_MS) {
      const wait = AAI_SESSION_COOLDOWN_MS - sinceLast;
      log(`Cooldown: waiting ${wait}ms before new session`);
      await new Promise(r => setTimeout(r, wait));
    }

    const params = new URLSearchParams({
      speech_model: 'u3-rt-pro',
      sample_rate: '16000',
      encoding: 'pcm_s16le',
      // max silence before turn is force-completed (ms)
      max_turn_silence: '1500',
    });
    // NOTE: keyterms_prompt in the URL causes AssemblyAI to close with 1011.
    // Send them via sendUpdateConfiguration after connection instead.
    const keyterms = identifiersFromActiveEditor(100);

    const url = `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
    log(`Connecting (url=${url.length}chars, ${keyterms.length} keyterms pending, key=${apiKey.slice(0, 8)}...)`);

    // AssemblyAI closes the connection (~100ms) if it receives no audio after open.
    // On macOS, FFmpeg's avfoundation needs 300-500ms to initialize the mic device.
    // Fix: buffer audio from FFmpeg FIRST, then connect the WS once audio is flowing.
    // We keep buffering during WS connection so no audio is lost.
    log('Waiting for first audio from FFmpeg before connecting WS...');

    const FRAME_BYTES = 3200; // 100ms at 16kHz 16-bit mono
    const MIN_FRAME = 1600;   // 50ms minimum for AssemblyAI

    // Shared buffer — keeps growing from input until WS open handler takes over
    let sharedBuf = Buffer.alloc(0);
    let audioChunks = 0;
    let totalAudioBytes = 0;
    let wsReady = false; // set true once WS open handler takes over

    const bufferListener = (chunk: Buffer) => {
      if (!chunk || !chunk.length || wsReady) return;
      audioChunks++;
      totalAudioBytes += chunk.length;
      sharedBuf = Buffer.concat([sharedBuf, chunk]);
    };
    input.on('data', bufferListener);

    // Wait until we have at least one full frame (3200 bytes = 100ms)
    await new Promise<void>((resolveWait, rejectWait) => {
      const timeout = setTimeout(() => {
        rejectWait(new Error('Timed out waiting for audio from FFmpeg (5s)'));
      }, 5000);

      const check = () => {
        if (sharedBuf.length >= FRAME_BYTES) {
          clearInterval(poll);
          clearTimeout(timeout);
          log(`Audio flowing: ${sharedBuf.length} bytes pre-buffered in ${audioChunks} chunks`);
          resolveWait();
        }
      };
      // Poll every 20ms (the data listener fills sharedBuf)
      const poll = setInterval(check, 20);
      check(); // immediate check

      // If stream dies before we get audio, bail
      const onEnd = () => { clearInterval(poll); clearTimeout(timeout); rejectWait(new Error('Audio stream ended before any data arrived')); };
      input.once('end', onEnd);
      input.once('close', onEnd);
      input.once('error', (e) => { clearInterval(poll); clearTimeout(timeout); rejectWait(e); });
    });

    log('Audio confirmed, now connecting WebSocket...');

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let transcript = '';

      const ws = new WS(url, {
        headers: { Authorization: apiKey },
      });
      _aaiActiveWs = ws;

      // Hard-kill backstop: if ws.close() doesn't trigger 'close' within 3s,
      // terminate the socket so it never lingers.
      let terminateTimer: NodeJS.Timeout | null = null;
      const scheduleTerminate = () => {
        if (!terminateTimer) {
          terminateTimer = setTimeout(() => {
            log('Backstop: ws.terminate() — graceful close timed out');
            try { (ws as any).terminate(); } catch {}
          }, 3000);
        }
      };

      const NOISE_WORDS = new Set([
        'the', 'a', 'an', 'and', 'uh', 'um', 'oh', 'ah', 'hmm', 'huh',
        'it', 'is', 'i', 'so', 'but', 'or', 'if', 'of', 'in', 'on',
        'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
        'nine', 'ten', 'to', 'too', 'for', 'ate', 'won',
        'hey', 'hi', 'bye', 'hm', 'mm',
      ]);
      const isNoiseWord = (txt: string): boolean => {
        if (!txt || !txt.trim()) return true;
        const clean = txt.trim().replace(/[^a-zA-Z0-9\s]/g, '').trim().toLowerCase();
        if (!clean) return true;
        const words = clean.split(/\s+/);
        if (words.length === 1 && NOISE_WORDS.has(words[0])) return true;
        if (words.length === 2 && NOISE_WORDS.has(words[0]) && NOISE_WORDS.has(words[1])) return true;
        return false;
      };

      // Pending result — we store what to resolve/reject with, but only
      // actually settle the promise once the WS is fully closed.
      // This prevents "too many concurrent sessions" from overlapping WS.
      let pendingResult: { value: string } | null = null;
      let pendingError: Error | null = null;

      const safeResolve = (txt: string) => {
        if (settled) return;
        if (isNoiseWord(txt)) {
          log(`Ignoring noise word: "${txt}"`);
          transcript = '';
          resetSafety();
          return;
        }
        settled = true;
        log(`RESOLVING with: "${txt}"`);
        if (safetyTimer) clearTimeout(safetyTimer);
        pendingResult = { value: txt };
        // Gracefully terminate the session so AssemblyAI releases the slot
        try {
          if (ws.readyState === WS.OPEN) {
            ws.send(JSON.stringify({ type: 'Terminate' }));
            log('Sent Terminate for graceful session close');
          } else {
            ws.close();
          }
        } catch { try { ws.close(); scheduleTerminate(); } catch {} }
        // Fallback: if Termination response doesn't arrive in 1s, force close
        setTimeout(() => { try { ws.close(); scheduleTerminate(); } catch {} }, 1000);
      };
      const safeReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        const msg = err instanceof Error ? err.message : String(err);
        log(`REJECTING: ${msg}`);
        if (safetyTimer) clearTimeout(safetyTimer);
        pendingError = err instanceof Error ? err : new Error(String(err));
        try { ws.close(); scheduleTerminate(); } catch { /* noop */ }
        // reject happens in ws.on('close') after WS is truly shut down
      };

      // Safety net: if nothing resolves after 8s, use whatever we have
      const EOT_SAFETY_MS = 8000;
      let safetyTimer: NodeJS.Timeout | null = null;
      const resetSafety = () => {
        if (safetyTimer) clearTimeout(safetyTimer);
        safetyTimer = setTimeout(() => {
          if (!settled) {
            log(`Safety timeout — resolving with: "${transcript}"`);
            settled = true;
            pendingResult = { value: transcript };
            try { ws.close(); scheduleTerminate(); } catch { /* noop */ }
          }
        }, EOT_SAFETY_MS);
      };

      // When the mic stream ends (FFmpeg killed), force-flush the current turn
      // then terminate the session.
      const handleStreamEnd = () => {
        if (settled) return;
        log(`handleStreamEnd called (wsState=${ws.readyState})`);
        try {
          if (ws.readyState === WS.OPEN) {
            // ForceEndpoint tells AssemblyAI to immediately finalize the current turn
            ws.send(JSON.stringify({ type: 'ForceEndpoint' }));
          }
        } catch { /* noop */ }
        // Give the server a moment to send the final Turn, then terminate
        setTimeout(() => {
          try {
            if (ws.readyState === WS.OPEN) {
              ws.send(JSON.stringify({ type: 'Terminate' }));
            }
          } catch { /* noop */ }
        }, 500);
        // Hard fallback: if we still haven't settled, force-resolve
        setTimeout(() => {
          if (!settled) {
            log(`Force-resolving after stream end: "${transcript}"`);
            settled = true;
            if (safetyTimer) clearTimeout(safetyTimer);
            pendingResult = { value: transcript };
            try { ws.close(); scheduleTerminate(); } catch { /* noop */ }
          }
        }, 2000);
      };

      ws.on('unexpected-response', (_req: any, res: any) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          log(`HTTP REJECTION: ${res.statusCode} — ${body}`);
          safeReject(new Error(`AssemblyAI returned ${res.statusCode}: ${body}`));
        });
      });

      ws.on('error', (e: any) => {
        log(`WS ERROR: ${e?.message || e}`);
        safeReject(e);
      });

      ws.on('open', () => {
        log('WebSocket connected');
        resetSafety();

        // Send keyterms via UpdateConfiguration (URL param causes 1011)
        if (keyterms.length > 0) {
          try {
            ws.send(JSON.stringify({
              type: 'UpdateConfiguration',
              keyterms_prompt: keyterms,
            }));
            log(`Sent ${keyterms.length} keyterms via UpdateConfiguration`);
          } catch { /* noop */ }
        }

        // Take over from the shared pre-buffer and stop the pre-buffer listener
        wsReady = true;
        input.removeListener('data', bufferListener);
        let audioBuf = sharedBuf;
        const preBufferedBytes = audioBuf.length;
        sharedBuf = Buffer.alloc(0); // free reference

        // Immediately flush the pre-buffered frames so AssemblyAI gets audio right away
        const flushFrames = () => {
          while (audioBuf.length >= FRAME_BYTES && ws.readyState === WS.OPEN) {
            const frame = audioBuf.subarray(0, FRAME_BYTES);
            audioBuf = audioBuf.subarray(FRAME_BYTES);
            try { ws.send(frame); } catch { /* ignore backpressure */ }
          }
        };
        const preFrames = Math.floor(preBufferedBytes / FRAME_BYTES);
        flushFrames();
        log(`Flushed ${preFrames} pre-buffered frame(s) (${preBufferedBytes} bytes)`);

        // Continue streaming audio from FFmpeg
        input.on('data', (chunk: Buffer) => {
          if (!chunk || !chunk.length) return;
          audioChunks++;
          totalAudioBytes += chunk.length;
          audioBuf = Buffer.concat([audioBuf, chunk]);
          flushFrames();
        });

        let streamEndHandled = false;
        const onStreamEnd = () => {
          if (streamEndHandled) return;
          streamEndHandled = true;
          log(`Stream ended: ${audioChunks} chunks, ${totalAudioBytes} bytes total`);
          // Flush any remaining audio (even if < FRAME_BYTES) — pad to minimum 50ms
          if (audioBuf.length > 0 && ws.readyState === WS.OPEN) {
            const toSend = audioBuf.length >= MIN_FRAME ? audioBuf : Buffer.concat([audioBuf, Buffer.alloc(MIN_FRAME - audioBuf.length)]);
            try { ws.send(toSend); } catch { /* noop */ }
            audioBuf = Buffer.alloc(0);
          }
          handleStreamEnd();
        };
        input.on('end', onStreamEnd);
        input.on('close', onStreamEnd);
        input.on('error', (err) => safeReject(err));
      });

      ws.on('message', (raw: Buffer | string) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        const msgType: string = msg?.type ?? '';

        if (msgType === 'Begin') {
          log(`Session started (id=${msg?.id}, expires=${msg?.expires_at})`);
          return;
        }

        if (msgType === 'SpeechStarted') {
          log(`Speech detected at ${msg?.timestamp}ms`);
          return;
        }

        if (msgType === 'Turn') {
          const txt: string = (msg?.transcript ?? '').trim();
          const endOfTurn: boolean = msg?.end_of_turn === true;

          if (txt) {
            transcript = txt;
            resetSafety();
          }

          if (endOfTurn) {
            log(`EndOfTurn: "${transcript}"`);
            if (transcript) safeResolve(transcript);
          } else if (txt && onInterim) {
            onInterim(transcript);
          }
          return;
        }

        if (msgType === 'Termination') {
          log('Termination message received');
          if (!settled) {
            settled = true;
            if (safetyTimer) clearTimeout(safetyTimer);
            pendingResult = { value: transcript };
          }
          // Always close WS on Termination (even if already settled by safeResolve)
          try { ws.close(); } catch { /* noop */ }
          return;
        }

        // Log any unknown message types
        log(`Unknown message type: ${msgType}`);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason?.toString() || '';
        const CLOSE_REASONS: Record<number, string> = {
          1000: 'Normal closure',
          1008: 'Authentication failed',
          1011: 'Server internal error (often: no audio received)',
          3005: 'Server error',
          3006: 'Invalid message format',
          3007: 'Audio chunk violation / sent faster than real-time',
          3008: 'Session exceeded max duration',
          3009: 'Concurrency limit exceeded',
        };
        const codeLabel = CLOSE_REASONS[code] || 'Unknown';
        log(`WS closed: code=${code} (${codeLabel}) reason="${reasonStr}" transcript="${transcript}"`);
        _aaiActiveWs = null;
        _aaiLastCloseTime = Date.now();
        if (terminateTimer) { clearTimeout(terminateTimer); terminateTimer = null; }
        if (safetyTimer) clearTimeout(safetyTimer);

        // Now that the WS is truly closed, settle the promise.
        // Add a small delay so AssemblyAI's backend fully releases the session slot
        // before we open a new one (prevents "too many concurrent sessions").
        const settle = () => {
          if (pendingResult) {
            resolve(pendingResult.value);
          } else if (pendingError) {
            reject(pendingError);
          } else if (!settled) {
            settled = true;
            if (code === 1008 || (code >= 3000 && code <= 3999)) {
              reject(new Error(`AssemblyAI closed ${code}: ${codeLabel}${reasonStr ? ' — ' + reasonStr : ''}`));
            } else {
              resolve(transcript);
            }
          }
        };
        // Wait 1500ms after WS close for AssemblyAI to release the session slot
        setTimeout(settle, 1500);
      });
    });
  }

  /**
   * Persistent AssemblyAI streaming session that processes multiple turns within
   * a single WebSocket connection. Yields one transcript string per completed turn.
   *
   * This avoids the "too many concurrent sessions" error caused by rapidly
   * opening/closing WS sessions in a loop.
   */
  async *transcribeStreamAssemblyAITurns(
    input: NodeJS.ReadableStream,
    onInterim?: (partial: string) => void
  ): AsyncGenerator<string, void, undefined> {
    const WS = (await import('ws')).default;
    const apiKey = this.assemblyaiApiKey || process.env.ASSEMBLYAI_API_KEY || '';
    if (!apiKey) throw new Error('AssemblyAI API key not set');

    const t0 = Date.now();
    const log = (msg: string) => console.log(`[Mantra] AAI-persistent +${Date.now() - t0}ms: ${msg}`);

    // Force-close any lingering WS from a previous session
    if (_aaiActiveWs) {
      log('Force-closing lingering WS from previous session');
      try {
        if (_aaiActiveWs.readyState === 1 /* OPEN */) {
          _aaiActiveWs.send(JSON.stringify({ type: 'Terminate' }));
        }
        _aaiActiveWs.terminate();
      } catch { /* noop */ }
      _aaiActiveWs = null;
      await new Promise(r => setTimeout(r, 1500));
    }

    // Enforce cooldown between sessions
    const sinceLast = Date.now() - _aaiLastCloseTime;
    if (_aaiLastCloseTime > 0 && sinceLast < AAI_SESSION_COOLDOWN_MS) {
      const wait = AAI_SESSION_COOLDOWN_MS - sinceLast;
      log(`Cooldown: waiting ${wait}ms before new session`);
      await new Promise(r => setTimeout(r, wait));
    }

    const params = new URLSearchParams({
      speech_model: 'u3-rt-pro',
      sample_rate: '16000',
      encoding: 'pcm_s16le',
      max_turn_silence: '1500',
    });
    const keyterms = identifiersFromActiveEditor(100);
    const url = `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
    log(`Connecting persistent session (${keyterms.length} keyterms, key=${apiKey.slice(0, 8)}...)`);

    // --- Pre-buffer audio from FFmpeg before connecting WS ---
    const FRAME_BYTES = 3200; // 100ms at 16kHz 16-bit mono
    const MIN_FRAME = 1600;   // 50ms minimum for AssemblyAI
    let sharedBuf = Buffer.alloc(0);
    let audioChunks = 0;
    let totalAudioBytes = 0;
    let wsReady = false;

    const bufferListener = (chunk: Buffer) => {
      if (!chunk || !chunk.length || wsReady) return;
      audioChunks++;
      totalAudioBytes += chunk.length;
      sharedBuf = Buffer.concat([sharedBuf, chunk]);
    };
    input.on('data', bufferListener);

    await new Promise<void>((resolveWait, rejectWait) => {
      const timeout = setTimeout(() => {
        rejectWait(new Error('Timed out waiting for audio from FFmpeg (5s)'));
      }, 5000);
      const check = () => {
        if (sharedBuf.length >= FRAME_BYTES) {
          clearInterval(poll);
          clearTimeout(timeout);
          log(`Audio flowing: ${sharedBuf.length} bytes pre-buffered in ${audioChunks} chunks`);
          resolveWait();
        }
      };
      const poll = setInterval(check, 20);
      check();
      const onEnd = () => { clearInterval(poll); clearTimeout(timeout); rejectWait(new Error('Audio stream ended before any data arrived')); };
      input.once('end', onEnd);
      input.once('close', onEnd);
      input.once('error', (e) => { clearInterval(poll); clearTimeout(timeout); rejectWait(e); });
    });

    log('Audio confirmed, connecting persistent WebSocket...');

    // --- Turn queue for async generator ---
    const turnQueue: string[] = [];
    let turnNotify: (() => void) | null = null;
    let wsError: Error | null = null;
    let wsClosed = false;

    const NOISE_WORDS = new Set([
      'the', 'a', 'an', 'and', 'uh', 'um', 'oh', 'ah', 'hmm', 'huh',
      'it', 'is', 'i', 'so', 'but', 'or', 'if', 'of', 'in', 'on',
      'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
      'nine', 'ten', 'to', 'too', 'for', 'ate', 'won',
      'hey', 'hi', 'bye', 'hm', 'mm',
    ]);
    const isNoiseWord = (txt: string): boolean => {
      if (!txt || !txt.trim()) return true;
      const clean = txt.trim().replace(/[^a-zA-Z0-9\s]/g, '').trim().toLowerCase();
      if (!clean) return true;
      const words = clean.split(/\s+/);
      if (words.length === 1 && NOISE_WORDS.has(words[0])) return true;
      if (words.length === 2 && NOISE_WORDS.has(words[0]) && NOISE_WORDS.has(words[1])) return true;
      return false;
    };

    const ws = new WS(url, { headers: { Authorization: apiKey } });
    _aaiActiveWs = ws;

    let terminateTimer: NodeJS.Timeout | null = null;
    const scheduleTerminate = () => {
      if (!terminateTimer) {
        terminateTimer = setTimeout(() => {
          log('Backstop: ws.terminate() — graceful close timed out');
          try { (ws as any).terminate(); } catch { /* noop */ }
        }, 3000);
      }
    };

    // --- WS event handlers ---
    ws.on('unexpected-response', (_req: any, res: any) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        log(`HTTP REJECTION: ${res.statusCode} — ${body}`);
        wsError = new Error(`AssemblyAI returned ${res.statusCode}: ${body}`);
        wsClosed = true;
        turnNotify?.();
      });
    });

    ws.on('error', (e: any) => {
      log(`WS ERROR: ${e?.message || e}`);
      wsError = e instanceof Error ? e : new Error(String(e));
      turnNotify?.();
    });

    ws.on('open', () => {
      log('Persistent WebSocket connected');

      // Send keyterms via UpdateConfiguration
      if (keyterms.length > 0) {
        try {
          ws.send(JSON.stringify({ type: 'UpdateConfiguration', keyterms_prompt: keyterms }));
          log(`Sent ${keyterms.length} keyterms`);
        } catch { /* noop */ }
      }

      // Take over from pre-buffer
      wsReady = true;
      input.removeListener('data', bufferListener);
      let audioBuf = sharedBuf;
      const preBufferedBytes = audioBuf.length;
      sharedBuf = Buffer.alloc(0);

      const flushFrames = () => {
        while (audioBuf.length >= FRAME_BYTES && ws.readyState === WS.OPEN) {
          const frame = audioBuf.subarray(0, FRAME_BYTES);
          audioBuf = audioBuf.subarray(FRAME_BYTES);
          try { ws.send(frame); } catch { /* ignore backpressure */ }
        }
      };
      flushFrames();
      log(`Flushed ${Math.floor(preBufferedBytes / FRAME_BYTES)} pre-buffered frame(s)`);

      // Continue streaming audio
      input.on('data', (chunk: Buffer) => {
        if (!chunk || !chunk.length) return;
        audioChunks++;
        totalAudioBytes += chunk.length;
        audioBuf = Buffer.concat([audioBuf, chunk]);
        flushFrames();
      });

      let streamEndHandled = false;
      const onStreamEnd = () => {
        if (streamEndHandled) return;
        streamEndHandled = true;
        log(`Stream ended: ${audioChunks} chunks, ${totalAudioBytes} bytes total`);
        // Flush remaining audio
        if (audioBuf.length > 0 && ws.readyState === WS.OPEN) {
          const toSend = audioBuf.length >= MIN_FRAME ? audioBuf : Buffer.concat([audioBuf, Buffer.alloc(MIN_FRAME - audioBuf.length)]);
          try { ws.send(toSend); } catch { /* noop */ }
          audioBuf = Buffer.alloc(0);
        }
        // ForceEndpoint + Terminate to flush last turn and end session
        try { if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ type: 'ForceEndpoint' })); } catch { /* noop */ }
        setTimeout(() => {
          try {
            if (ws.readyState === WS.OPEN) {
              ws.send(JSON.stringify({ type: 'Terminate' }));
            }
          } catch { /* noop */ }
        }, 500);
      };
      input.on('end', onStreamEnd);
      input.on('close', onStreamEnd);
      input.on('error', (err) => {
        wsError = err instanceof Error ? err : new Error(String(err));
        turnNotify?.();
      });
    });

    let transcript = '';
    ws.on('message', (raw: Buffer | string) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const msgType: string = msg?.type ?? '';

      if (msgType === 'Begin') {
        log(`Session started (id=${msg?.id}, expires=${msg?.expires_at})`);
        return;
      }
      if (msgType === 'SpeechStarted') {
        log(`Speech detected at ${msg?.timestamp}ms`);
        return;
      }
      if (msgType === 'Turn') {
        const txt: string = (msg?.transcript ?? '').trim();
        const endOfTurn: boolean = msg?.end_of_turn === true;
        if (txt) transcript = txt;

        if (endOfTurn) {
          log(`EndOfTurn: "${transcript}"`);
          if (transcript && !isNoiseWord(transcript)) {
            turnQueue.push(transcript);
            turnNotify?.();
          } else if (transcript) {
            log(`Ignoring noise: "${transcript}"`);
          }
          transcript = ''; // reset for next turn
        } else if (txt && onInterim) {
          onInterim(transcript);
        }
        return;
      }
      if (msgType === 'Termination') {
        log('Termination message received');
        wsClosed = true;
        turnNotify?.();
        return;
      }
      log(`Unknown message type: ${msgType}`);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString() || '';
      const CLOSE_REASONS: Record<number, string> = {
        1000: 'Normal closure',
        1008: 'Authentication failed',
        1011: 'Server internal error',
        3005: 'Server error',
        3006: 'Invalid message format',
        3007: 'Audio chunk violation',
        3008: 'Session exceeded max duration',
        3009: 'Concurrency limit exceeded',
      };
      const codeLabel = CLOSE_REASONS[code] || 'Unknown';
      log(`WS closed: code=${code} (${codeLabel}) reason="${reasonStr}"`);
      _aaiActiveWs = null;
      _aaiLastCloseTime = Date.now();
      if (terminateTimer) { clearTimeout(terminateTimer); terminateTimer = null; }
      wsClosed = true;
      if (code === 1008 || (code >= 3000 && code <= 3999)) {
        wsError = wsError || new Error(`AssemblyAI closed ${code}: ${codeLabel}${reasonStr ? ' — ' + reasonStr : ''}`);
      }
      turnNotify?.();
    });

    // --- Async generator loop: yield completed turns ---
    try {
      while (true) {
        while (turnQueue.length > 0) {
          yield turnQueue.shift()!;
        }
        if (wsError) throw wsError;
        if (wsClosed) return;
        await new Promise<void>(r => { turnNotify = r; });
        turnNotify = null;
      }
    } finally {
      // Clean up the WS session
      log('Generator cleanup — closing WS');
      _aaiActiveWs = null;
      try {
        if (ws.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ type: 'Terminate' }));
        }
      } catch { /* noop */ }
      setTimeout(() => {
        try { ws.close(); scheduleTerminate(); } catch { /* noop */ }
      }, 500);
    }
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

    const selModel = this.getModel();

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

  async semanticGoto(
    description: string,
    symbolNames: string[],
  ): Promise<string | null> {
    if (symbolNames.length === 0) return null;

    const systemPrompt = [
      'You are a code navigation assistant.',
      'Given a spoken description and a list of symbol names from a code file,',
      'return the EXACT name of the symbol that best matches the description.',
      'Output ONLY the symbol name, nothing else. No explanation, no quotes, no reasoning.',
      'If no symbol matches the description, output: NONE',
    ].join('\n');

    const userPrompt = [
      `Description: "${description}"`,
      '',
      'Symbols in file:',
      ...symbolNames.map(n => `- ${n}`),
    ].join('\n');

    try {
      const raw = await this.chatText({
        model: this.getModel(),
        temperature: 0,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      const result = (raw || '').trim();
      if (result === 'NONE' || !result) return null;

      // Verify against provided list (exact, then case-insensitive)
      const exact = symbolNames.find(n => n === result);
      if (exact) return exact;
      const ci = symbolNames.find(n => n.toLowerCase() === result.toLowerCase());
      return ci ?? null;
    } catch (err) {
      console.warn('[Mantra] Semantic goto LLM failed:', err);
      return null;
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
      agentBackend?: 'claude' | 'none';
      activityLog?: string;
      workspaceFiles?: string;
      hasPreExistingSelection?: boolean;
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

    const agentName = ctx.agentBackend === 'claude' ? 'Claude Code' : null;
    const hasSel = !!ctx.hasPreExistingSelection;
    let agentNote: string;
    if (agentName && hasSel) {
      // Agent active + user has text selected → modification available for small edits
      agentNote = `\nIMPORTANT — An AI agent (${agentName}) is active and the user has text selected. Prefer "agent" over "modification" for anything non-trivial. Use "modification" ONLY for small, targeted edits on the selected text (rename a variable, change a loop type, add a single line, remove a comment, etc.). For anything that requires thought, planning, multi-step work, new features, refactoring, or is even slightly complex, use "agent". When ambiguous, default to "agent". NEVER use "question" to answer something the agent could handle — "question" is ONLY for quick factual answers when no agent is available or the user explicitly asks a brief knowledge question like "what does this line do?".`;
    } else if (agentName && !hasSel) {
      // Agent active + no selection → modification NOT available
      agentNote = `\nIMPORTANT — An AI agent (${agentName}) is active. The user has NO text selected in the editor, so the "modification" type is NOT available — NEVER output "modification". Only "command", "terminal", "agent", and "question" are valid output types. For ANY code editing request (rename a variable, change a loop, add a line, etc.), use "agent" — the agent will handle it. When ambiguous, default to "agent". NEVER use "question" to answer something the agent could handle — "question" is ONLY for quick factual answers when the user explicitly asks a brief knowledge question like "what does this line do?".`;
    } else if (!agentName && hasSel) {
      // No agent + user has text selected → modification available
      agentNote = `\nIMPORTANT: No AI agent is active. The "agent" type is NOT available — NEVER output "agent" or "claude". The user has text selected, so "modification" is available for code edits on the selected text. Only "question", "command", "modification", and "terminal" are valid output types. For knowledge/explanation questions, use "question" and provide a helpful answer.`;
    } else {
      // No agent + no selection → neither modification nor agent available
      agentNote = `\nIMPORTANT: No AI agent is active and the user has NO text selected. The "agent" type is NOT available — NEVER output "agent" or "claude". The "modification" type is also NOT available — NEVER output "modification" (no text is selected to edit). Only "question", "command", and "terminal" are valid output types. For code editing requests, use "question" and explain the changes the user should make. For knowledge/explanation questions, use "question" and provide a helpful answer.`;
    }

    const system = [
      systemBase,
      agentNote,
      '',
      'Canonical command catalog (authoritative; choose ONLY from these when outputting type=command):',
      commandList || '- (none provided)'
    ].join('\n');
    const parts: string[] = [];

    // Include activity log if available (recent session history)
    if (ctx.activityLog) {
      parts.push('Activity log (recent session history):');
      parts.push(ctx.activityLog);
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

    // Include workspace file listing if available
    if (ctx.workspaceFiles) {
      parts.push('Workspace files and folders (use these exact names for terminal commands):');
      parts.push(ctx.workspaceFiles);
      parts.push('');
    }

    parts.push(fullFileStr);

    // --- Selection mode: if user has text manually selected, instruct LLM to output only the replacement ---
    let isSelectionMode = false;
    if (ctx.editor && !ctx.editor.selection.isEmpty && ctx.hasPreExistingSelection) {
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

    const activeModel = this.getModel();
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
      const activeModel = this.getModel();
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