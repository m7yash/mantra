import * as vscode from 'vscode';

export interface SidebarState {
  volume?: number;        // 0-1 RMS level
  memory?: string;        // conversation memory text
  mic?: string;           // current microphone name
  provider?: string;      // e.g. "groq / gpt-oss-20b"
  lastTranscript?: string;
  listening?: boolean;
  testing?: boolean;      // mic test mode
  routerPrompt?: string;  // main LLM system prompt
  memoryPrompt?: string;  // memory manager system prompt
}

export class MantraSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mantra.sidebar';
  private _view?: vscode.WebviewView;
  private _cachedState: SidebarState = {};
  private _onMemoryEdit?: (text: string) => void;
  private _onPromptEdit?: (key: string, text: string) => void;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /** Register a callback for when the user edits memory in the sidebar. */
  public onMemoryEdit(cb: (text: string) => void): void {
    this._onMemoryEdit = cb;
  }

  /** Register a callback for when the user edits a prompt in the sidebar. */
  public onPromptEdit(cb: (key: string, text: string) => void): void {
    this._onPromptEdit = cb;
  }

  /** Push live state to the webview. Caches so the sidebar can restore on re-open. */
  public postState(state: SidebarState): void {
    Object.assign(this._cachedState, state);
    this._view?.webview.postMessage({ type: 'state', ...state });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'command') {
        vscode.commands.executeCommand(msg.command);
      } else if (msg.type === 'openKeybindings') {
        vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'mantra');
      } else if (msg.type === 'promptEdit') {
        if (this._onPromptEdit && typeof msg.key === 'string' && typeof msg.text === 'string') {
          this._onPromptEdit(msg.key, msg.text);
        }
      } else if (msg.type === 'memoryEdit') {
        if (this._onMemoryEdit && typeof msg.text === 'string') {
          this._onMemoryEdit(msg.text);
        }
      } else if (msg.type === 'ready') {
        // Webview loaded — push cached state so it's populated immediately
        if (Object.keys(this._cachedState).length > 0) {
          this._view?.webview.postMessage({ type: 'state', ...this._cachedState });
        }
      }
    });
  }

  private _getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px 10px 20px;
  }

  /* ── Toggle button ── */
  .toggle-wrap { padding: 0 0 6px; }
  .toggle-btn {
    width: 100%;
    padding: 10px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    border-radius: 6px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: opacity 0.1s;
  }
  .toggle-btn:hover { opacity: 0.85; }
  .toggle-hint {
    font-size: 10px;
    font-weight: 400;
    opacity: 0.7;
  }

  /* ── Volume meter ── */
  .meter-wrap {
    padding: 0 0 8px;
  }
  .meter-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .meter-icon {
    font-size: 13px;
    flex-shrink: 0;
    opacity: 0.7;
  }
  .meter-track {
    flex: 1;
    height: 4px;
    background: var(--vscode-widget-border, rgba(128,128,128,0.2));
    border-radius: 2px;
    overflow: hidden;
  }
  .meter-fill {
    height: 100%;
    width: 0%;
    background: var(--vscode-button-background);
    border-radius: 2px;
    transition: width 0.08s linear;
  }
  .meter-label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    padding-top: 3px;
  }

  /* ── Status row ── */
  .status-row {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 2px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status-row strong {
    color: var(--vscode-foreground);
    font-weight: 500;
  }

  /* ── Section ── */
  .section-label {
    text-transform: uppercase;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    padding: 10px 0 4px;
  }

  /* ── Row buttons ── */
  button.row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    margin: 1px 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    cursor: pointer;
    text-align: left;
  }
  button.row:hover { background: var(--vscode-list-hoverBackground); }
  button.row:active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .row-icon {
    font-size: 14px;
    width: 18px;
    text-align: center;
    flex-shrink: 0;
    opacity: 0.8;
  }
  .row-label { flex: 1; }
  .row-hint {
    margin-left: auto;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }

  /* ── Divider ── */
  .divider {
    height: 1px;
    background: var(--vscode-widget-border, rgba(128,128,128,0.2));
    margin: 8px 0;
  }

  /* ── Memory ── */
  .memory-wrap {
    padding: 4px 0 0;
  }
  .memory-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .memory-text {
    font-size: 11px;
    line-height: 1.45;
    color: var(--vscode-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25));
    border-radius: 4px;
    padding: 6px 8px;
    margin: 4px 0;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
    font-family: var(--vscode-font-family);
    outline: none;
    resize: vertical;
  }
  .memory-empty {
    font-size: 11px;
    font-style: italic;
    color: var(--vscode-disabledForeground);
    padding: 4px 0;
  }
  textarea.prompt-area {
    width: 100%;
    min-height: 100px;
    max-height: 300px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--vscode-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25));
    border-radius: 4px;
    padding: 6px 8px;
    margin: 4px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    resize: vertical;
    outline: none;
  }
  textarea.prompt-area:focus {
    border-color: var(--vscode-focusBorder);
  }
  .transcript-text {
    font-size: 11px;
    font-style: italic;
    color: var(--vscode-descriptionForeground);
    padding: 2px 0 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
</head>
<body>

  <!-- Start / Pause toggle -->
  <div class="toggle-wrap">
    <button class="toggle-btn" id="toggleBtn">
      <span id="toggleLabel">Start Listening</span>
      <span class="toggle-hint" id="toggleHint">Ctrl+Shift+1</span>
    </button>
  </div>

  <!-- Mic test -->
  <div style="padding:0 0 6px;">
    <button class="toggle-btn" id="testBtn" style="background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));font-weight:500;font-size:12px;padding:7px;">
      <span id="testLabel">Test Microphone</span>
    </button>
  </div>

  <!-- Volume meter (hidden until listening or testing) -->
  <div class="meter-wrap" id="meterWrap" style="display:none;">
    <div class="meter-row">
      <span class="meter-icon">&#127908;</span>
      <div class="meter-track"><div class="meter-fill" id="meterFill"></div></div>
    </div>
    <div class="meter-label" id="micLabel"></div>
  </div>

  <!-- Status info (hidden until listening) -->
  <div id="statusWrap" style="display:none;">
    <div class="status-row" id="providerRow"></div>
    <div class="transcript-text" id="transcriptRow"></div>
  </div>

  <div class="divider"></div>

  <!-- Focus -->
  <div class="section-label">Focus</div>
  <button class="row" data-cmd="workbench.action.focusActiveEditorGroup">
    <span class="row-icon">&#9998;</span>
    <span class="row-label">Editor</span>
  </button>
  <button class="row" data-cmd="workbench.action.terminal.focus">
    <span class="row-icon">&#9002;</span>
    <span class="row-label">Terminal</span>
  </button>
  <button class="row" data-cmd="mantra.focusClaude">
    <span class="row-icon">&#9671;</span>
    <span class="row-label">Claude</span>
  </button>
  <button class="row" data-cmd="workbench.view.explorer">
    <span class="row-icon">&#128193;</span>
    <span class="row-label">Explorer</span>
  </button>
  <button class="row" data-cmd="workbench.view.search">
    <span class="row-icon">&#128270;</span>
    <span class="row-label">Search</span>
  </button>
  <button class="row" data-cmd="workbench.view.scm">
    <span class="row-icon">&#9906;</span>
    <span class="row-label">Source Control</span>
  </button>

  <div class="divider"></div>

  <!-- Settings -->
  <div class="section-label">Settings</div>
  <button class="row" data-cmd="mantra.selectMicrophone">
    <span class="row-icon">&#127908;</span>
    <span class="row-label">Microphone</span>
    <span class="row-hint">Ctrl+Shift+4</span>
  </button>
  <button class="row" data-cmd="mantra.toggleCommandsOnly">
    <span class="row-icon">&#8644;</span>
    <span class="row-label">Commands-Only Mode</span>
  </button>
  <button class="row" data-cmd="mantra.openSettings">
    <span class="row-icon">&#9881;</span>
    <span class="row-label">All Settings</span>
    <span class="row-hint">Ctrl+Shift+3</span>
  </button>
  <button class="row" id="keybindingsBtn">
    <span class="row-icon">&#9000;</span>
    <span class="row-label">Keyboard Shortcuts</span>
  </button>

  <div class="divider"></div>

  <!-- API Keys -->
  <div class="section-label">API Keys</div>
  <button class="row" data-cmd="mantra.editDeepgramApiKey">
    <span class="row-icon">&#128273;</span>
    <span class="row-label">Deepgram</span>
  </button>
  <button class="row" data-cmd="mantra.editGroqApiKey">
    <span class="row-icon">&#128273;</span>
    <span class="row-label">Groq</span>
  </button>
  <button class="row" data-cmd="mantra.editCerebrasApiKey">
    <span class="row-icon">&#128273;</span>
    <span class="row-label">Cerebras</span>
  </button>

  <div class="divider"></div>

  <!-- Memory -->
  <div id="memoryWrap" style="display:none;">
    <div class="section-label">Session Memory (sent to LLM)</div>
    <div class="memory-text" id="memoryText" contenteditable="true" spellcheck="false"></div>
    <div style="font-size:10px;color:var(--vscode-descriptionForeground);padding:2px 0;">Edit above to correct or add context for the LLM.</div>
  </div>

  <!-- Prompts -->
  <div class="section-label">Router Prompt</div>
  <textarea class="prompt-area" id="routerPrompt" spellcheck="false" placeholder="Loading..."></textarea>

  <div class="section-label">Memory Manager Prompt</div>
  <textarea class="prompt-area" id="memoryPrompt" spellcheck="false" placeholder="Loading..."></textarea>

  <script>
    const vscode = acquireVsCodeApi();
    let listening = false;
    let testing = false;

    const toggleBtn = document.getElementById('toggleBtn');
    const toggleLabel = document.getElementById('toggleLabel');
    const toggleHint = document.getElementById('toggleHint');
    const testBtn = document.getElementById('testBtn');
    const testLabel = document.getElementById('testLabel');
    const meterWrap = document.getElementById('meterWrap');
    const meterFill = document.getElementById('meterFill');
    const micLabel = document.getElementById('micLabel');
    const statusWrap = document.getElementById('statusWrap');
    const providerRow = document.getElementById('providerRow');
    const transcriptRow = document.getElementById('transcriptRow');
    const memoryWrap = document.getElementById('memoryWrap');
    const memoryText = document.getElementById('memoryText');
    const routerPromptEl = document.getElementById('routerPrompt');
    const memoryPromptEl = document.getElementById('memoryPrompt');

    toggleBtn.addEventListener('click', () => {
      if (listening) {
        vscode.postMessage({ type: 'command', command: 'mantra.pause' });
      } else {
        vscode.postMessage({ type: 'command', command: 'mantra.start' });
      }
    });

    testBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'command', command: 'mantra.testMicrophone' });
    });

    document.querySelectorAll('button.row[data-cmd]').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'command', command: btn.dataset.cmd });
      });
    });

    document.getElementById('keybindingsBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openKeybindings' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type !== 'state') return;

      if (msg.volume !== undefined) {
        const pct = Math.min(100, Math.round(msg.volume * 600));
        meterFill.style.width = pct + '%';
      }

      if (msg.mic !== undefined && msg.mic) {
        micLabel.textContent = msg.mic;
      }

      if (msg.provider !== undefined && msg.provider) {
        providerRow.textContent = msg.provider;
      }

      if (msg.lastTranscript !== undefined && msg.lastTranscript) {
        transcriptRow.textContent = '\\u201c' + msg.lastTranscript + '\\u201d';
      }

      if (msg.memory !== undefined) {
        if (msg.memory) {
          memoryText.textContent = msg.memory;
          memoryWrap.style.display = '';
        } else {
          memoryWrap.style.display = 'none';
        }
      }

      if (msg.routerPrompt !== undefined) {
        routerPromptEl.value = msg.routerPrompt;
      }

      if (msg.memoryPrompt !== undefined) {
        memoryPromptEl.value = msg.memoryPrompt;
      }

      if (msg.testing !== undefined) {
        testing = msg.testing;
        testLabel.textContent = testing ? 'Stop Test' : 'Test Microphone';
        meterWrap.style.display = testing ? '' : (listening ? '' : 'none');
        if (!testing && !listening) {
          meterFill.style.width = '0%';
        }
      }

      if (msg.listening !== undefined) {
        listening = msg.listening;
        toggleLabel.textContent = listening ? 'Pause Listening' : 'Start Listening';
        toggleHint.textContent = listening ? 'Ctrl+Shift+2' : 'Ctrl+Shift+1';
        meterWrap.style.display = listening ? '' : (testing ? '' : 'none');
        statusWrap.style.display = listening ? '' : 'none';
        if (!listening && !testing) {
          meterFill.style.width = '0%';
        }
      }
    });

    // Debounced memory edit → extension
    let memoryTimer = null;
    memoryText.addEventListener('input', () => {
      clearTimeout(memoryTimer);
      memoryTimer = setTimeout(() => {
        vscode.postMessage({ type: 'memoryEdit', text: memoryText.innerText });
      }, 500);
    });

    // Debounced prompt edits → extension
    function debouncePrompt(el, key) {
      let timer = null;
      el.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          vscode.postMessage({ type: 'promptEdit', key: key, text: el.value });
        }, 800);
      });
    }
    debouncePrompt(routerPromptEl, 'prompt');
    debouncePrompt(memoryPromptEl, 'memoryPrompt');

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
