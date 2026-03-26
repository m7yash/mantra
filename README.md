# Mantra

Code with your thoughts, not your keyboard. Extremely accurate, absurdly fast.

Mantra listens to your voice and instantly edits code, runs IDE commands, executes terminal commands, interacts with AI agents (Claude Code or Codex CLI), or answers your questions — all hands-free.

Get started for free!

Demo: https://youtu.be/ZSNIh9Qce8w

Discord: https://discord.gg/fmWCScWuUn

> Please read the Privacy and Data Handling section before use.
> Use a good quality and well-positioned desktop microphone for best results.

---

## How It Works

1. **Speech-to-text:** Audio is streamed to **Deepgram Flux** (conversational STT with built-in turn detection). A keyterm list biases recognition toward programming vocabulary and identifiers from your open file.
2. **LLM routing:** The transcript + editor context + terminal history + conversation memory is sent to **Groq** (or Cerebras). The LLM classifies the instruction and returns one of five types:
   - **command** — runs a VS Code command (75+ supported)
   - **modification** — applies an edit to the current file (changes are highlighted in green/red)
   - **question** — shows the answer in a separate panel
   - **terminal** — translates natural language to a shell command and executes it
   - **agent** — forwards an intelligent, context-aware prompt to the selected AI agent (Claude Code or Codex CLI)
3. **Pre-LLM shortcuts:** Common phrases like "undo", "save", "scroll down", "enter", "delete", "focus editor", "ask Claude ...", and keyboard shortcuts are handled instantly without waiting for the LLM.

---

## Setup

### 1) Install Mantra from the VS Code Marketplace

### 2) Provide API keys on first run

- **Deepgram** — speech-to-text. Get a key at https://deepgram.com (free $200 credit).
- **Groq** (recommended) or **Cerebras** — LLM routing. Get a key at https://console.groq.com or https://cloud.cerebras.ai

You'll be prompted the first time. Keys are stored in VS Code Secret Storage.

### 3) Start!

Run **"Mantra: Start Recording"** from the Command Palette, press `Ctrl+Shift+1`, or click **Start Listening** in the Mantra sidebar panel (activity bar icon).

---

## What You Can Say

### Code editing
- "create a terminal-based tic tac toe game"
- "change this to a while loop"
- "add a helper function to validate user input"
- "put getters and setters"
- "for i in range len nums print nums i" (raw code dictation)

### Questions
- "what does this function do?"
- "how should I refactor this?"
- "explain this line"

### IDE commands
- "undo", "redo", "save", "format document"
- "close this file", "open utils dot java"
- "select lines 4 to 19", "go to line 20"
- "delete", "delete line", "delete this line"
- "scroll down", "scroll up 5 lines", "page up"
- "toggle sidebar", "zen mode", "zoom in"
- "focus editor", "focus terminal", "focus explorer"

### Terminal commands
- "run this file" → `python3 main.py`
- "create a virtual environment" → `python3 -m venv venv`
- "install the requests library" → `pip3 install requests`
- "check git status" → `git status`

Terminal commands are **executed by default**. If you want to just type without executing, say something like "create a virtual environment **but don't run it**" or "type it out **and wait**".

### Keyboard shortcuts (macOS)
Any modifier+key combo spoken naturally is executed via the system:
- "command B" → Cmd+B
- "control shift P" → Ctrl+Shift+P
- "command shift F" → Cmd+Shift+F

### Other system actions
- "click" → simulates pressing Enter/Return
- "open Safari", "open Chrome" → launches the app (macOS)
- "enter" → presses Enter in whatever is focused

### Pause / Resume
Say "pause" or "stop listening" to pause. Say "resume" or use `Ctrl+Shift+1` to start again.

---

## Agent Integration (Claude Code & Codex CLI)

Mantra supports two AI agent backends: **Claude Code** (via the VS Code extension) and **Codex CLI** (via `npm install -g @openai/codex`). Only one agent can be active at a time — select which one to use from the **Agent** dropdown in the sidebar Settings section.

### Prerequisites

- **Claude Code** — Install the [Claude Code VS Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code). The `claude` CLI must be in your PATH.
- **Codex CLI** — Install via `npm install -g @openai/codex`. If the CLI is not found, an install button appears in the sidebar.

### Sending prompts to the agent
Say "ask Claude to refactor this function", "tell Codex to add unit tests", "ask agent how to fix that", or "ask LLM to explain this error". All of these — regardless of which name you use — route to whichever agent is currently selected. Mantra's LLM uses conversation memory and terminal history to craft a context-aware prompt, so you can say vague things like "ask Claude how to fix that" and it will resolve "that" to whatever you were just working on.

Common phrases like "ask Claude ...", "tell Codex ...", "ask agent ...", "ask LLM ...", "ask AI ..." are intercepted before the LLM for instant routing.

### When the agent is running
While the agent terminal is active:
- **Commands still work normally** — "save file", "undo", "focus terminal" all execute as usual
- **Questions and conversation go to the agent** — "how do I fix this error?" types into the agent
- **"enter"** — presses Enter (confirms permission prompts, submits input)
- **"up" / "down"** — arrow keys for navigating selection menus
- **"yes" / "ok" / "go ahead"** — confirms the current selection
- **"focus editor" / "go back"** — switches back to the editor
- **"focus agent" / "open claude" / "open codex"** — switches to (or opens) the agent terminal

### Agent CLI commands (voice)
- "new conversation" / "clear conversation"
- "resume conversation"
- "set model to [model name]"
- "claude status", "claude help"
- "compact conversation"
- "undo that" (Claude undo)
- "stop" / "interrupt" / "cancel" (sends Ctrl+C)
- "accept changes" / "reject changes" (for proposed diffs)

---

## Sidebar Panel

Mantra adds a panel to the VS Code activity bar. From the sidebar you can:

- **Start / Pause listening** with a single toggle button
- **Test Microphone** — verify your mic is working with a live volume meter (no STT needed)
- **Activity Log** — scrollable history of every transcript, command, code edit, terminal action, question, and agent interaction. Code modifications include a "Show diff" toggle to view exactly what changed.
- **Focus** — quick buttons to switch between Editor, Terminal, Agent, Explorer, Search, and Source Control
- **Settings**
  - **Agent** — choose between Claude Code and Codex CLI (only one active at a time). Shows an install button if the selected agent's CLI is not found.
  - **LLM Provider** — Groq or Cerebras
  - **Model** — select the LLM model (options update based on provider)
  - **Microphone** — pick your input device
  - **Commands-Only Mode** — toggle with ON/OFF indicator (see below)
  - **All Settings** / **Keyboard Shortcuts**
- **API Keys** — configure Deepgram, Groq, and Cerebras keys
- **Session Memory** — view and edit the running session context that the LLM uses. Edits take effect immediately.
- **Router Prompt** — view and edit the main LLM system prompt directly in the sidebar
- **Memory Manager Prompt** — view and edit the prompt that controls how session memory is summarized

---

## Commands-Only Mode

Toggle via the sidebar or Command Palette. When enabled (shown as **ON** in the sidebar):

- **No LLM calls** — speech is still transcribed via Deepgram, but the transcript is only matched against pre-mapped commands and text operations.
- **What works:** all 75+ IDE commands ("save", "undo", "format document"), text operations ("go to line 20", "select lines 4 to 19", "scroll down", "delete line"), keyboard shortcuts ("command B"), focus/navigation commands, and pause/resume.
- **What doesn't work:** code edits, questions, terminal command generation, and agent forwarding — anything that requires the LLM to interpret intent.

This is useful for low-latency command execution without any API calls beyond speech-to-text, or when you don't have an LLM API key configured.

---

## Conversation Memory

Mantra maintains a running memory of your session. After each interaction, the LLM updates a summary that includes what you asked, what actions were taken, file context, and terminal output. This means later instructions can reference earlier ones naturally — "do the same thing for the other file", "ask Claude how to fix that error from before", etc.

The session memory and both LLM prompts (router and memory manager) are visible and editable in the sidebar panel.

---

## Terminal History Tracking

Mantra automatically captures terminal commands and their output via VS Code shell integration. This history is:
- Included as context for the LLM (so it knows what you just ran and what happened)
- Used when forwarding to the agent (so the agent can see errors and output)
- Stored for the session (up to 50 commands)

---

## Commands & Keyboard Shortcuts

- **Start Recording** — `Ctrl+Shift+1`
- **Pause Listening** — `Ctrl+Shift+2`
- **Open Settings** — `Ctrl+Shift+3`
- **Select Microphone** — `Ctrl+Shift+4`
- **Test Microphone** — available from sidebar or Command Palette
- **Focus Agent Panel** — available from sidebar or Command Palette
- **Focus Claude Code Panel** — available from Command Palette
- **Focus Codex CLI Panel** — available from Command Palette

All shortcuts can be customized in **File > Preferences > Keyboard Shortcuts** (search "mantra"), or via the Keyboard Shortcuts button in the sidebar.

---

## Settings

Open **Settings > Extensions > Mantra** to adjust:

- **Agent Backend** — Choose between **Claude Code** (default) or **Codex CLI**. Only one agent can be active at a time.
- **LLM Provider** — Choose between **Groq** (default) or **Cerebras**.
- **Reasoning Effort** — Low (default), medium, or high.
- **Prompt** — Customize the LLM system prompt (also editable in the sidebar).
- **Memory Manager Prompt** — Customize the prompt that summarizes session context (also editable in the sidebar).
- **Commands Only** — Bypass the LLM entirely. Only pre-mapped commands and text operations work.
- **Microphone Input** — Set via Command Palette > "Mantra: Select Microphone". Advanced users can paste raw FFmpeg input args.

---

## Privacy and Data Handling (Important)

- **Your responsibility:** Do not dictate passwords, tokens, or proprietary text you don't want transmitted. Pause listening when working with sensitive files. DO NOT USE MANTRA WHEN EDITING FILES WITH SENSITIVE CREDENTIALS. If Mantra detects sensitive information in your file, it will warn you before sending it to the LLM.
- **What goes to the speech model:** A small list of keyterms (command phrases, language keywords, identifiers from the open file) is sent to Deepgram to bias recognition. No full source code is sent to Deepgram.
- **What goes to the LLM:** The current file's full contents, file name, cursor context, terminal history, and conversation memory.
- **Secrets & storage:** API keys are stored in VS Code Secret Storage. No keys are written to disk in plaintext.
- **For more:** See Deepgram's and Groq's/Cerebras's privacy policies. Other than the API usage described above, Mantra runs entirely locally and does not collect, save, or share any of your data.

---

## Troubleshooting

- **No mic on macOS** — Allow VS Code under *System Settings > Privacy & Security > Microphone*.
- **"Command not found: claude"** — Add the CLI to your PATH: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`
- **Codex CLI not found** — Install via `npm install -g @openai/codex`, or use the install button in the sidebar.
- **Ghost transcriptions ("two", "four")** — These are filtered automatically. If ambient noise is high, consider adjusting your microphone position.
- **File not found** — Include punctuation words when speaking filenames: "open auth dot controller dot ts".
- **Logs** — Check **View > Output > Mantra** for detailed logs including which microphone is being used. The sidebar Activity Log also shows a history of all transcripts and actions.

---

## Supported IDE Commands

Over 75 pre-mapped VS Code commands. You can say these exactly or use natural variations (the LLM understands intent):

> save, save all, new file, close file, close other files, close all files, reopen closed editor, undo, redo, cut, copy, paste, select all, toggle line comment, toggle block comment, format document, format selection, rename symbol, quick fix, organize imports, expand selection, shrink selection, select next occurrence, duplicate line down, duplicate line up, move line up, move line down, add cursor above, add cursor below, fold all, unfold all, toggle word wrap, find, replace, find in files, replace in files, back, forward, next tab, previous tab, tab one through tab nine, page up, page down, go to definition, peek definition, go to references, go to implementation, jump to bracket, focus editor, focus first editor, focus second editor, focus sidebar, focus panel, toggle output, toggle sidebar, toggle panel, toggle zen mode, split editor, toggle minimap, zoom in, zoom out, reset zoom, toggle terminal, focus terminal, new terminal, next terminal, previous terminal, focus agent, new conversation, accept changes, reject changes, focus explorer, focus search, focus source control, focus debug, focus extensions, show command palette, quick open, toggle breakpoint, start debugging, stop debugging, continue debugging, step over, step into, step out.

Additional text operations handled directly (no LLM needed): go to line N, select/copy/cut/delete line N, select/copy/cut/delete lines A to B, scroll up/down [N lines/pages], page up/down, new line above/below, indent, outdent, delete, paste.

---

## WSL2 (Windows Subsystem for Linux) — Quick Setup

Mantra works in a **Remote - WSL** window. Use **WSLg** (audio bridge) and a Pulse-enabled **FFmpeg**.

### Recommended (WSLg enabled)
1. **Windows PowerShell (Admin)**
   ```powershell
   wsl --update
   wsl --shutdown
   ```
2. **In WSL Ubuntu**
   ```bash
   sudo apt update && sudo apt install -y ffmpeg pulseaudio-utils
   export MANTRA_FFMPEG_PATH=/usr/bin/ffmpeg
   code .
   ```
3. In VS Code: **Command Palette > "Mantra: Select Microphone"** > choose a device.
4. Set API keys and start recording.

### Alternative (no WSLg)
- Open the folder directly in **Windows VS Code**, or
- Use the Windows mic from WSL:
  ```bash
  export MANTRA_FFMPEG_PATH="/mnt/c/ffmpeg/bin/ffmpeg.exe"
  export MANTRA_AUDIO_INPUT='-f dshow -i audio=Microphone (Your Device Name)'
  code .
  ```

### Troubleshooting (WSL)
- **"PulseAudio: Connection refused"** — WSLg not active: `wsl --update` then `wsl --shutdown`.
- **"Unknown input format 'pulse'"** — Wrong FFmpeg: install Ubuntu ffmpeg and set `MANTRA_FFMPEG_PATH=/usr/bin/ffmpeg`.
- **No mics in picker** — Enable WSLg and relaunch VS Code from the WSL shell (`code .`).

### Persist FFmpeg path
```bash
echo 'export MANTRA_FFMPEG_PATH=/usr/bin/ffmpeg' >> ~/.bashrc
```

---

## Notes

- FFmpeg is used automatically if available; there is nothing extra to install.
- The extension loads after VS Code startup; listening begins only when you invoke **Mantra: Start Recording**.
- All voice control executes standard VS Code commands or safe editor edits; you can always undo changes on your own or just say "undo".
