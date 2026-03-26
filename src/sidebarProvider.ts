import * as vscode from 'vscode';

export interface LogEntry {
  time: string;           // HH:MM:SS
  kind: 'transcript' | 'command' | 'modification' | 'terminal' | 'question' | 'claude' | 'codex' | 'error' | 'info';
  text: string;           // main text
  diff?: string;          // unified diff for modifications
  diffId?: number;        // ID to open full diff in a tab
}

export interface SidebarState {
  volume?: number;        // 0-1 RMS level
  memory?: string;        // conversation memory text
  mic?: string;           // current microphone name
  provider?: string;      // e.g. "Groq" or "Cerebras"
  lastTranscript?: string;
  listening?: boolean;
  testing?: boolean;      // mic test mode
  routerPrompt?: string;  // main LLM system prompt
  memoryPrompt?: string;  // memory manager system prompt
  selectionPrompt?: string; // selection model system prompt
  agentBackend?: string;  // 'claude' | 'codex'
  agentInstalled?: boolean; // whether selected agent CLI is installed
  llmProvider?: string;   // 'groq' | 'cerebras'
  commandsOnly?: boolean; // commands-only mode toggle
  availableMics?: Array<{label: string, args: string}>; // enumerated microphones
  micArgs?: string;       // currently selected mic args string
}

export class MantraSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mantra.sidebar';
  private _view?: vscode.WebviewView;
  private _cachedState: SidebarState = {};
  private _logs: LogEntry[] = [];
  private _onMemoryEdit?: (text: string) => void;
  private _onPromptEdit?: (key: string, text: string) => void;
  private _onAgentChange?: (agent: string) => void;
  private _onProviderChange?: (provider: string) => void;
  private _onInstallAgent?: () => void;
  private _onMicChange?: (args: string) => void;
  private _onOpenDiffTab?: (diffId: number) => void;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /** Register a callback for when the user edits memory in the sidebar. */
  public onMemoryEdit(cb: (text: string) => void): void {
    this._onMemoryEdit = cb;
  }

  /** Register a callback for when the user edits a prompt in the sidebar. */
  public onPromptEdit(cb: (key: string, text: string) => void): void {
    this._onPromptEdit = cb;
  }

  /** Register a callback for when the user changes the agent backend. */
  public onAgentChange(cb: (agent: string) => void): void {
    this._onAgentChange = cb;
  }

  /** Register a callback for when the user changes the LLM provider. */
  public onProviderChange(cb: (provider: string) => void): void {
    this._onProviderChange = cb;
  }

  /** Register a callback for when the user clicks the install button. */
  public onInstallAgent(cb: () => void): void {
    this._onInstallAgent = cb;
  }

  /** Register a callback for when the user changes the microphone dropdown. */
  public onMicChange(cb: (args: string) => void): void {
    this._onMicChange = cb;
  }

  /** Register a callback for when the user clicks "Open in tab" on a diff. */
  public onOpenDiffTab(cb: (diffId: number) => void): void {
    this._onOpenDiffTab = cb;
  }

  /** Push live state to the webview. Caches so the sidebar can restore on re-open. */
  public postState(state: SidebarState): void {
    Object.assign(this._cachedState, state);
    this._view?.webview.postMessage({ type: 'state', ...state });
  }

  /** Push a log entry to the activity log. */
  public pushLog(entry: LogEntry): void {
    this._logs.push(entry);
    if (this._logs.length > 200) this._logs.splice(0, this._logs.length - 200);
    this._view?.webview.postMessage({ type: 'log', entry });
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
      } else if (msg.type === 'agentChange') {
        if (this._onAgentChange && typeof msg.agent === 'string') {
          this._onAgentChange(msg.agent);
        }
      } else if (msg.type === 'providerChange') {
        if (this._onProviderChange && typeof msg.provider === 'string') {
          this._onProviderChange(msg.provider);
        }
      } else if (msg.type === 'installAgent') {
        if (this._onInstallAgent) {
          this._onInstallAgent();
        }
      } else if (msg.type === 'micChange') {
        if (this._onMicChange && typeof msg.args === 'string') {
          this._onMicChange(msg.args);
        }
      } else if (msg.type === 'openDiffTab') {
        if (this._onOpenDiffTab && typeof msg.diffId === 'number') {
          this._onOpenDiffTab(msg.diffId);
        }
      } else if (msg.type === 'ready') {
        // Webview loaded — push cached state so it's populated immediately
        if (Object.keys(this._cachedState).length > 0) {
          this._view?.webview.postMessage({ type: 'state', ...this._cachedState });
        }
        // Replay cached logs
        for (const entry of this._logs) {
          this._view?.webview.postMessage({ type: 'log', entry });
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

  /* ── Dropdown ── */
  .dropdown {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25));
    border-radius: 4px;
    background: var(--vscode-input-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
    margin: 4px 0;
    cursor: pointer;
  }
  .dropdown:focus {
    border-color: var(--vscode-focusBorder);
  }
  .install-wrap {
    padding: 4px 0 6px;
  }
  .install-msg {
    font-size: 11px;
    color: var(--vscode-editorWarning-foreground, #cca700);
    padding: 2px 0 4px;
  }
  .install-btn {
    width: 100%;
    padding: 6px 10px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    font-family: var(--vscode-font-family);
    font-size: 12px;
    cursor: pointer;
  }
  .install-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3));
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

  /* ── Activity Log ── */
  .log-wrap {
    padding: 4px 0 0;
    max-height: 400px;
    overflow-y: auto;
  }
  .log-entry {
    padding: 4px 6px;
    margin: 2px 0;
    border-radius: 3px;
    font-size: 11px;
    line-height: 1.4;
    border-left: 3px solid transparent;
  }
  .log-entry.transcript { border-left-color: var(--vscode-charts-blue, #3794ff); }
  .log-entry.command { border-left-color: var(--vscode-charts-green, #89d185); }
  .log-entry.modification { border-left-color: var(--vscode-charts-yellow, #cca700); }
  .log-entry.terminal { border-left-color: var(--vscode-charts-purple, #b180d7); }
  .log-entry.question { border-left-color: var(--vscode-charts-orange, #d18616); }
  .log-entry.claude { border-left-color: var(--vscode-charts-red, #f14c4c); }
  .log-entry.error { border-left-color: var(--vscode-errorForeground, #f44); }
  .log-entry.info { border-left-color: var(--vscode-descriptionForeground); }
  .log-time {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-right: 6px;
  }
  .log-kind {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    opacity: 0.7;
    margin-right: 4px;
  }
  .log-text {
    color: var(--vscode-foreground);
    word-break: break-word;
  }
  .log-diff-toggle {
    font-size: 10px;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    margin-top: 2px;
    display: inline-block;
  }
  .log-diff-toggle:hover { text-decoration: underline; }
  .log-diff {
    display: none;
    margin-top: 4px;
    padding: 4px 6px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 300px;
    overflow-y: auto;
  }
  .diff-add { color: var(--vscode-gitDecoration-addedResourceForeground, #89d185); }
  .diff-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f44); }
  .diff-hdr { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .log-empty {
    font-size: 11px;
    font-style: italic;
    color: var(--vscode-disabledForeground);
    padding: 4px 0;
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

  <!-- Activity Log -->
  <div class="section-label">Activity Log</div>
  <div class="log-wrap" id="logWrap">
    <div class="log-empty" id="logEmpty">No activity yet. Start listening to see logs.</div>
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
  <button class="row" data-cmd="mantra.focusAgent">
    <span class="row-icon">&#9671;</span>
    <span class="row-label" id="focusAgentLabel">Agent</span>
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

  <div style="padding:2px 0;">
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 0;">Agent</div>
    <select id="agentSelect" class="dropdown">
      <option value="claude">Claude Code</option>
      <option value="codex">Codex CLI</option>
    </select>
    <div id="installWrap" class="install-wrap" style="display:none;">
      <div class="install-msg" id="installMsg">Agent CLI is not installed.</div>
      <button class="install-btn" id="installBtn">Install via npm</button>
    </div>
  </div>
  <div style="padding:2px 0;">
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 0;">LLM Provider</div>
    <select id="providerSelect" class="dropdown">
      <option value="groq">Groq</option>
      <option value="cerebras">Cerebras</option>
    </select>
  </div>
  <div style="padding:2px 0;">
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 0;">Microphone</div>
    <select id="micSelect" class="dropdown">
      <option value="">Detecting...</option>
    </select>
  </div>
  <button class="row" data-cmd="mantra.toggleCommandsOnly" id="cmdOnlyBtn">
    <span class="row-icon">&#8644;</span>
    <span class="row-label" id="cmdOnlyLabel">Commands-Only Mode</span>
    <span class="row-hint" id="cmdOnlyHint">OFF</span>
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

  <div class="section-label">Selection Model Prompt</div>
  <textarea class="prompt-area" id="selectionPrompt" spellcheck="false" placeholder="Loading..."></textarea>

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
    const selectionPromptEl = document.getElementById('selectionPrompt');
    const logWrap = document.getElementById('logWrap');
    const logEmpty = document.getElementById('logEmpty');
    const agentSelect = document.getElementById('agentSelect');
    const installWrap = document.getElementById('installWrap');
    const installMsg = document.getElementById('installMsg');
    const installBtn = document.getElementById('installBtn');
    const providerSelect = document.getElementById('providerSelect');
    const focusAgentLabel = document.getElementById('focusAgentLabel');
    const cmdOnlyHint = document.getElementById('cmdOnlyHint');
    const micSelect = document.getElementById('micSelect');

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

    // Agent backend dropdown
    agentSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'agentChange', agent: agentSelect.value });
    });

    // Install button
    installBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'installAgent' });
    });

    // LLM Provider dropdown
    providerSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'providerChange', provider: providerSelect.value });
    });

    // Microphone dropdown
    micSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'micChange', args: micSelect.value });
    });

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function renderDiffHtml(diff) {
      return diff.split('\\n').map(line => {
        const esc = escHtml(line);
        if (line.startsWith('@@')) return '<span class="diff-hdr">' + esc + '</span>';
        if (line.startsWith('+'))  return '<span class="diff-add">' + esc + '</span>';
        if (line.startsWith('-'))  return '<span class="diff-del">' + esc + '</span>';
        return esc;
      }).join('\\n');
    }

    let logCounter = 0;

    function addLogEntry(entry) {
      if (logEmpty) logEmpty.style.display = 'none';
      const id = 'logdiff' + (logCounter++);
      const el = document.createElement('div');
      el.className = 'log-entry ' + (entry.kind || 'info');

      let html = '<span class="log-time">' + escHtml(entry.time) + '</span>'
        + '<span class="log-kind">' + escHtml(entry.kind) + '</span>'
        + '<span class="log-text">' + escHtml(entry.text) + '</span>';

      if (entry.diff) {
        html += '<br><span class="log-diff-toggle" onclick="var d=document.getElementById(\\'' + id + '\\');d.style.display=d.style.display===\\'none\\'?\\'block\\':\\'none\\'">Show diff</span>';
        if (entry.diffId !== undefined) {
          html += ' &middot; <span class="log-diff-toggle" onclick="vscode.postMessage({type:\\'openDiffTab\\',diffId:' + entry.diffId + '})">Open in tab</span>';
        }
        html += '<div class="log-diff" id="' + id + '">' + renderDiffHtml(entry.diff) + '</div>';
      }

      el.innerHTML = html;
      logWrap.appendChild(el);
      logWrap.scrollTop = logWrap.scrollHeight;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'log') { addLogEntry(msg.entry); return; }
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

      if (msg.selectionPrompt !== undefined) {
        selectionPromptEl.value = msg.selectionPrompt;
      }

      if (msg.agentBackend !== undefined) {
        agentSelect.value = msg.agentBackend;
        const label = msg.agentBackend === 'codex' ? 'Codex' : 'Claude';
        focusAgentLabel.textContent = label;
      }

      if (msg.agentInstalled !== undefined) {
        if (msg.agentInstalled) {
          installWrap.style.display = 'none';
        } else {
          const name = agentSelect.value === 'codex' ? 'Codex CLI' : 'Claude Code CLI';
          installMsg.textContent = name + ' is not installed.';
          installWrap.style.display = '';
        }
      }

      if (msg.llmProvider !== undefined) {
        providerSelect.value = msg.llmProvider;
      }

      if (msg.availableMics !== undefined) {
        micSelect.innerHTML = '';
        for (const mic of msg.availableMics) {
          const opt = document.createElement('option');
          opt.value = mic.args;
          opt.textContent = mic.label;
          micSelect.appendChild(opt);
        }
      }

      if (msg.micArgs !== undefined) {
        micSelect.value = msg.micArgs;
      }

      if (msg.commandsOnly !== undefined) {
        cmdOnlyHint.textContent = msg.commandsOnly ? 'ON' : 'OFF';
        cmdOnlyHint.style.color = msg.commandsOnly
          ? 'var(--vscode-charts-green, #89d185)'
          : 'var(--vscode-descriptionForeground)';
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
    debouncePrompt(selectionPromptEl, 'selectionPrompt');

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
