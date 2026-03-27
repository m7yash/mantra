# Mantra

Code with your thoughts, not your keyboard. Extremely accurate, absurdly fast.

Mantra listens to your voice and instantly edits code, runs IDE commands, executes terminal commands, interacts with AI agents (Claude Code or Codex), or answers your questions — all hands-free.

Get started for free!

Demo: https://youtu.be/ZSNIh9Qce8w

Discord: https://discord.gg/fmWCScWuUn

> Please read the Privacy and Data Handling section before use.
> Use a good quality and well-positioned desktop microphone for best results.

---

## How It Works

1. **Speech-to-text:** Audio is streamed to **Deepgram Flux** (conversational STT with built-in turn detection) or sent as a complete file to **Aqua Voice** (Avalon model). A keyterm list biases recognition toward programming vocabulary and identifiers from your open file. You can switch between STT providers in the sidebar.
2. **Context-aware routing:** When VS Code is the active window, the transcript goes through the full pipeline — commands, text operations, and LLM routing. **When another app is in the foreground** (Safari, Terminal, etc.), only system-level commands (navigation, scrolling, tab switching, clicking, app management) are processed. VS Code commands and code modifications are never accidentally triggered on other apps.
3. **LLM routing (VS Code focused):** The transcript + editor context + terminal history + conversation memory is sent to **Groq** (or Cerebras). The LLM classifies the instruction and returns one of five types:
   - **command** — runs a VS Code command (75+ supported)
   - **modification** — applies a small, targeted edit to the current file (changes are highlighted in green/red)
   - **question** — shows the answer in a separate panel (only used when no agent is available or the user says "quick question"). When no agent is selected, a note suggests selecting one for better handling of complex requests.
   - **terminal** — translates natural language to a shell command and executes it
   - **agent** — forwards an intelligent, context-aware prompt to the selected AI agent (Claude Code or Codex). This is the default for any non-trivial task when an agent is active. When no agent is selected, agent-type requests fall back to the quick question system.
4. **Pre-LLM shortcuts:** Common phrases like "undo", "save", "scroll down", "enter", "delete", "focus editor", "ask Claude ...", and keyboard shortcuts are handled instantly without waiting for the LLM.

---

## Setup

### 1) Install Mantra from the VS Code Marketplace

### 2) Provide API keys on first run

- **Deepgram** — speech-to-text (streaming). Get a key at https://deepgram.com (free $200 credit).
- **Aqua Voice** (optional) — speech-to-text (batch). Get a key at https://app.aquavoice.com/api-dashboard. Select "Aqua Voice" from the STT provider dropdown in the sidebar.
- **Groq** (recommended) or **Cerebras** — LLM routing. Get a key at https://console.groq.com or https://cloud.cerebras.ai

You'll be prompted the first time. Keys are stored in VS Code Secret Storage and can also be entered in the sidebar API Keys section.

### 3) Start!

Run **"Mantra: Start Recording"** from the Command Palette, press `Ctrl+Shift+1`, or click **Hands-Free Mode** in the Mantra sidebar panel (activity bar icon).

---

## What You Can Say

### Code editing (VS Code focused)
- "create a terminal-based tic tac toe game"
- "change this to a while loop"
- "add a helper function to validate user input"
- "put getters and setters"
- "for i in range len nums print nums i" (raw code dictation)

### Questions
- "quick question, what does this function do?"
- "quick question, what's the time complexity?"
- "quick question, explain this line"

> **Note:** Say "quick question" to always get an instant local answer, bypassing the agent and all other routing. When an agent is active and you don't say "quick question", knowledge questions are routed to the agent instead. When no agent is selected, all requests that would normally go to an agent are answered locally via the quick question system (with a note suggesting you select an agent).

### IDE commands (VS Code focused)
- "undo", "redo", "save", "format document"
- "close this file", "open utils dot java"
- "select lines 4 to 19", "go to line 20"
- "delete", "delete line", "delete this line"
- "scroll down", "scroll up 5 lines", "page up"
- "toggle sidebar", "zen mode", "zoom in"
- "focus editor", "focus terminal", "focus explorer"
- "next tab", "previous tab", "first tab", "tab three"

### Terminal commands (VS Code focused)
- "run this file" → `python3 main.py`
- "create a virtual environment" → `python3 -m venv venv`
- "install the requests library" → `pip3 install requests`
- "check git status" → `git status`

Terminal commands are **executed by default**. If you want to just type without executing, say something like "create a virtual environment **but don't run it**" or "type it out **and wait**".

### Keyboard shortcuts (macOS, any app)
Any modifier+key combo spoken naturally is executed via the system:
- "command B" → Cmd+B
- "control shift P" → Ctrl+Shift+P
- "command shift F" → Cmd+Shift+F

### Stop / Resume
Say "pause", "stop", or "stop listening" to stop. Say "resume" or use `Ctrl+Shift+1` to start again.

---

## System Commands (Any App)

These commands work regardless of which app is in the foreground. They are processed before any VS Code or LLM logic.

### Mouse
| Say | Action |
|-----|--------|
| "click" | Left click at current mouse position |
| "double click" | Double click at current mouse position |
| "right click" | Right click at current mouse position |
| "move mouse up/down/left/right [N]" | Move mouse N pixels (default 50) |

### Open & switch apps
| Say | Action |
|-----|--------|
| "open Safari", "open Chrome", "open Slack" | Open or focus the named app |
| "open VS Code", "open IDE", "open code", "open Visual Studio Code" | Open VS Code (aliases handled) |
| "switch to Safari", "switch to Terminal" | Bring the named app to front |

Polite phrasing works too — "could you please open Safari" is handled correctly.

### Browser navigation
| Say | Action |
|-----|--------|
| "back" / "go back" | Cmd+[ (browser back) |
| "forward" / "go forward" | Cmd+] (browser forward) |
| "refresh" / "reload" | Cmd+R |
| "hard refresh" | Cmd+Shift+R |
| "new tab" | Cmd+T |
| "close tab" | Cmd+W |
| "reopen tab" / "reopen closed tab" | Cmd+Shift+T |
| "address bar" / "url bar" | Cmd+L |
| "bookmark" / "bookmark page" | Cmd+D |

### Key presses
| Say | Action |
|-----|--------|
| "press enter", "press escape", "press tab" | Sends that key |
| "press up", "press down", "press left", "press right" | Arrow keys |
| "press page up", "press page down", "press home", "press end" | Navigation keys |

### Type text
| Say | Action |
|-----|--------|
| "type hello world" | Types the text via clipboard paste |

### Window management
| Say | Action |
|-----|--------|
| "minimize" | Cmd+M |
| "close window" | Cmd+W |
| "full screen" | Cmd+Ctrl+F |
| "next window" / "previous window" | Cmd+` / Cmd+Shift+` |
| "hide" / "hide app" | Cmd+H |
| "show desktop" | F11 |
| "mission control" | Ctrl+Up |

### System
| Say | Action |
|-----|--------|
| "spotlight" / "search computer" | Cmd+Space |
| "screenshot" | Cmd+Shift+3 (full screen) |
| "screenshot selection" | Cmd+Shift+4 (area) |
| "lock screen" | Cmd+Ctrl+Q |

---

## Unfocused Commands (When Another App Is Active)

When VS Code is **not** the frontmost window, these additional commands route keystrokes to whatever app you're using (Safari, Terminal.app, Finder, etc.). They do **not** trigger VS Code actions.

### Arrow keys & repetition
| Say | Action |
|-----|--------|
| "up", "down", "left", "right" | Arrow key |
| "up 5 times", "down three times" | Repeat arrow key N times |

### Scrolling
| Say | Action |
|-----|--------|
| "scroll up" / "scroll down" | Smooth scroll (15 arrow presses) |
| "scroll up a lot" / "scroll down a lot" | Big scroll (2 page jumps) |
| "page up" / "page down" | Single page jump |
| "scroll to top" / "scroll to bottom" | Cmd+Home / Cmd+End |

### Basic keys
| Say | Action |
|-----|--------|
| "enter" / "return" / "submit" | Enter key |
| "escape" / "cancel" / "dismiss" | Escape key |
| "tab" | Tab key |
| "space" | Space key |
| "delete" / "backspace" | Backspace key |

### Tab switching
| Say | Action |
|-----|--------|
| "next tab" / "previous tab" | Ctrl+Tab / Ctrl+Shift+Tab |
| "first tab", "second tab", ..., "ninth tab" | Cmd+1 through Cmd+9 |
| "tab 1", "tab 2", ..., "tab 9" | Cmd+1 through Cmd+9 |
| "last tab" | Cmd+9 |

### Text editing
| Say | Action |
|-----|--------|
| "undo" / "redo" | Cmd+Z / Cmd+Shift+Z |
| "copy" / "paste" / "cut" | Cmd+C / Cmd+V / Cmd+X |
| "select all" | Cmd+A |
| "find" / "search" | Cmd+F |
| "save" | Cmd+S |
| "close" / "quit" | Cmd+W / Cmd+Q |
| "zoom in" / "zoom out" / "reset zoom" | Cmd+= / Cmd+- / Cmd+0 |

### Selection
| Say | Action |
|-----|--------|
| "select to end" / "select to start" | Cmd+Shift+Right / Cmd+Shift+Left |
| "select word" | Option+Shift+Right |
| "select line" | Home then Shift+End |

### Developer tools (browser)
| Say | Action |
|-----|--------|
| "dev tools" / "inspect" / "inspect element" | Cmd+Option+I |
| "console" / "open console" | Cmd+Option+J |
| "view source" | Cmd+Option+U |

### Terminal.app / iTerm shortcuts
| Say | Action |
|-----|--------|
| "clear" / "clear terminal" | Cmd+K |
| "interrupt" / "control c" / "kill process" | Ctrl+C |
| "exit terminal" / "control d" | Ctrl+D |
| "suspend" / "control z" | Ctrl+Z |
| "reverse search" / "search history" / "control r" | Ctrl+R |
| "beginning of line" / "control a" | Ctrl+A |
| "end of line" / "control e" | Ctrl+E |
| "clear line" / "control u" | Ctrl+U |
| "delete word" / "control w" | Ctrl+W |

### Finder shortcuts
| Say | Action |
|-----|--------|
| "show hidden files" | Cmd+Shift+. |
| "go to folder" | Cmd+Shift+G |
| "new folder" | Cmd+Shift+N |
| "get info" / "file info" | Cmd+I |

---

## Agent Integration (Claude Code & Codex)

Mantra supports two AI agent backends: **Claude Code** (via the VS Code extension) and **Codex** (via `npm install -g @openai/codex`). Only one agent can be active at a time — select which one to use from the **Agent** dropdown in the sidebar Settings section.

When an agent is active, it becomes the **default destination** for any non-trivial request. You don't need to say "ask Claude" — just speak naturally and complex tasks are automatically routed to the agent. Simple edits ("change this to a while loop", "rename this variable") still go through the fast modification path.

When no agent is selected (**None**), all requests that would normally be routed to an agent are handled locally — complex coding tasks become file modifications and knowledge questions are answered via the quick question system.

### Prerequisites

- **Claude Code** — Install the [Claude Code VS Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code). The `claude` CLI must be in your PATH.
- **Codex** — Install via `npm install -g @openai/codex`. If the CLI is not found, an install button appears in the sidebar.

### Sending prompts to the agent
Say "ask Claude to refactor this function", "tell Codex to add unit tests", "ask agent how to fix that", or "ask LLM to explain this error". All of these — regardless of which name you use — route to whichever agent is currently selected. Mantra's LLM uses conversation memory and terminal history to craft a context-aware prompt, so you can say vague things like "ask Claude how to fix that" and it will resolve "that" to whatever you were just working on.

You can also just say what you want without mentioning any agent — "add an AI opponent", "improve the performance", "add authentication" — and it will be routed to the agent automatically.

Common phrases like "ask Claude ...", "tell Codex ...", "ask agent ...", "ask LLM ...", "ask AI ..." are intercepted before the LLM for instant routing. These also work when VS Code is not focused.

### When the agent is running (VS Code focused)
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

- **Hands-Free Mode / Stop** with a single toggle button
- **Push to Talk** — hold the button to record, release to transcribe and process. Useful for precise, single-utterance control.
- **Stop / Stop & Transcribe** (`Ctrl+Shift+2` / `Ctrl+Shift+3`) — while recording, the button splits into two options: stop (discard audio) or stop and transcribe what's been said so far.
- **Test Microphone** — verify your mic is working with a live volume meter (no STT needed)
- **Activity Log** — scrollable history of every transcript, command, code edit, terminal action, question, and agent interaction. Code modifications include:
  - **Show diff** — toggle to view exactly what changed (green/red highlighting)
  - **Open in tab** — open the diff in a full editor tab
  - **Undo / Redo** — revert or re-apply a specific change. After undoing, the button becomes "Redo this change" if the file hasn't been modified. Grayed out if the file has changed since.
- **Focus** — quick buttons to switch between Editor, Terminal, Agent, Explorer, Search, and Source Control
- **Settings**
  - **Agent** — choose between Claude Code and Codex (only one active at a time). Shows an install button if the selected agent's CLI is not found.
  - **LLM Provider** — Groq or Cerebras
  - **STT Provider** — Deepgram (streaming, real-time) or Aqua Voice (batch, sends full audio file)
  - **Silence Timeout** — (Aqua Voice only) how many seconds of silence before auto-transcribing. Default: 2s.
  - **Sensitivity** — (Aqua Voice only) microphone sensitivity for silence detection: Low (noisy environments), Medium (default), High (quiet environments).
  - **Model** — select the LLM model (options update based on provider)
  - **Microphone** — pick your input device. Changing the microphone while recording stops the current session (without transcribing) so the new mic is used on next start.
  - **Commands-Only Mode** — toggle with ON/OFF indicator (see below)
  - **All Settings** / **Keyboard Shortcuts**
- **API Keys** — configure Deepgram, Aqua Voice, Groq, and Cerebras keys
- **Session Memory** — view and edit the running session context that the LLM uses. Edits take effect immediately.
- **Router Prompt** — view and edit the main LLM system prompt directly in the sidebar
- **Memory Manager Prompt** — view and edit the prompt that controls how session memory is summarized

---

## Commands-Only Mode

Toggle via the sidebar or Command Palette. When enabled (shown as **ON** in the sidebar):

- **No LLM calls** — speech is still transcribed via your selected STT provider, but the transcript is only matched against pre-mapped commands and text operations.
- **What works:** all 75+ IDE commands ("save", "undo", "format document"), text operations ("go to line 20", "select lines 4 to 19", "scroll down", "delete line"), keyboard shortcuts ("command B"), system commands, focus/navigation commands, and pause/resume.
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
- **Stop Listening** — `Ctrl+Shift+2`
- **Stop & Transcribe** — `Ctrl+Shift+3` (force-transcribe current audio then stop)
- **Open Settings** — `Ctrl+Shift+4`
- **Select Microphone** — `Ctrl+Shift+5`
- **Push to Talk** — sidebar button only (hold to record, release to transcribe)
- **Test Microphone** — available from sidebar or Command Palette
- **Focus Agent Panel** — available from sidebar or Command Palette
- **Focus Claude Code Panel** — available from Command Palette
- **Focus Codex Panel** — available from Command Palette

All shortcuts can be customized in **File > Preferences > Keyboard Shortcuts** (search "mantra"), or via the Keyboard Shortcuts button in the sidebar.

---

## Settings

Open **Settings > Extensions > Mantra** to adjust:

- **Agent Backend** — Choose between **Claude Code**, **Codex**, or **None**. Only one agent can be active at a time.
- **LLM Provider** — Choose between **Groq** (default) or **Cerebras**.
- **STT Provider** — Choose between **Deepgram** (streaming, default) or **Aqua Voice** (batch).
- **Silence Timeout** — (Aqua Voice only) Seconds of silence before auto-transcribing. Default: 2s.
- **Reasoning Effort** — Low (default), medium, or high.
- **Prompt** — Customize the LLM system prompt (also editable in the sidebar).
- **Memory Manager Prompt** — Customize the prompt that summarizes session context (also editable in the sidebar).
- **Commands Only** — Bypass the LLM entirely. Only pre-mapped commands and text operations work.
- **Microphone Input** — Set via Command Palette > "Mantra: Select Microphone". Advanced users can paste raw FFmpeg input args.

---

## Privacy and Data Handling (Important)

- **Your responsibility:** Do not dictate passwords, tokens, or proprietary text you don't want transmitted. Pause listening when working with sensitive files. DO NOT USE MANTRA WHEN EDITING FILES WITH SENSITIVE CREDENTIALS. If Mantra detects sensitive information in your file, it will warn you before sending it to the LLM.
- **What goes to the speech model:** A small list of keyterms (command phrases, language keywords, identifiers from the open file) is sent to Deepgram to bias recognition. No full source code is sent to Deepgram or Aqua Voice. When using Aqua Voice, the full audio recording is sent as a file for batch transcription.
- **What goes to the LLM:** The current file's full contents, file name, cursor context, terminal history, and conversation memory.
- **Secrets & storage:** API keys are stored in VS Code Secret Storage. No keys are written to disk in plaintext.
- **For more:** See Deepgram's and Groq's/Cerebras's privacy policies. Other than the API usage described above, Mantra runs entirely locally and does not collect, save, or share any of your data.

---

## Troubleshooting

- **No mic on macOS** — Allow VS Code under *System Settings > Privacy & Security > Microphone*.
- **Mouse click not working** — Allow VS Code under *System Settings > Privacy & Security > Accessibility*.
- **"Command not found: claude"** — Add the CLI to your PATH: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`
- **Codex not found** — Install via `npm install -g @openai/codex`, or use the install button in the sidebar.
- **Ghost transcriptions ("two", "four")** — These are filtered automatically. If ambient noise is high, consider adjusting your microphone position.
- **File not found** — Include punctuation words when speaking filenames: "open auth dot controller dot ts".
- **Logs** — Check **View > Output > Mantra** for detailed logs including which microphone is being used. The sidebar Activity Log also shows a history of all transcripts and actions.

---

## Supported IDE Commands (VS Code Focused)

Over 75 pre-mapped VS Code commands. You can say these exactly or use natural variations (the LLM understands intent):

> save, save all, new file, close file, close other files, close all files, reopen closed editor, undo, redo, cut, copy, paste, select all, toggle line comment, toggle block comment, format document, format selection, rename symbol, quick fix, organize imports, expand selection, shrink selection, select next occurrence, duplicate line down, duplicate line up, move line up, move line down, add cursor above, add cursor below, fold all, unfold all, toggle word wrap, find, replace, find in files, replace in files, next tab, previous tab, tab one through tab nine, page up, page down, go to definition, peek definition, go to references, go to implementation, jump to bracket, focus editor, focus first editor, focus second editor, focus sidebar, focus panel, toggle output, toggle sidebar, toggle panel, toggle zen mode, split editor, toggle minimap, zoom in, zoom out, reset zoom, toggle terminal, focus terminal, new terminal, next terminal, previous terminal, focus agent, new conversation, accept changes, reject changes, focus explorer, focus search, focus source control, focus debug, focus extensions, show command palette, quick open, toggle breakpoint, start debugging, stop debugging, continue debugging, step over, step into, step out, stage file, stage all, unstage file, commit, push, pull, checkout branch, show diff, stash, pop stash, toggle fullscreen, show problems, show notifications, clear notifications, reveal in finder, copy file path, copy relative path, markdown preview, run task, run build task, run test task, clear terminal, terminal scroll up, terminal scroll down.

Additional text operations handled directly (no LLM needed): go to line N, select/copy/cut/delete line N, select/copy/cut/delete lines A to B, scroll up/down [N lines/pages], page up/down, new line above/below, indent, outdent, delete, paste, kill process, tab complete, run last command.

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
- System commands (mouse, app switching, browser navigation, etc.) are macOS only.
