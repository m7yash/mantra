# Mantra

Code with your thoughts, not your keyboard. Extremely accurate, absurdly fast.

Mantra listens to your voice and instantly edits code, runs IDE commands, executes terminal commands, interacts with an AI agent (Claude Code), or answers your questions — all hands-free.

Get started for free!

Demo: https://youtu.be/ZSNIh9Qce8w

Discord: https://discord.gg/fmWCScWuUn

> Please read the Privacy and Data Handling section before use.
> Use a good quality and well-positioned desktop microphone for best results.

---

## How It Works

1. **Speech-to-text:** Audio is streamed to **Deepgram Flux** (conversational STT with built-in turn detection), **AssemblyAI** (streaming or batch), or sent as a complete file to **Aqua Voice** (Avalon model). The most frequent identifiers from your open file are sent as keyterms to bias recognition toward your code's vocabulary. You can switch between STT providers in the sidebar.
2. **Context-aware routing:** When VS Code is the active window, the transcript goes through the full pipeline — commands, text operations, and LLM routing. **When another app is in the foreground** (Safari, Terminal, etc.), only system-level commands (navigation, scrolling, tab switching, clicking, app management) are processed. VS Code commands and code modifications are never accidentally triggered on other apps.
3. **LLM routing (VS Code focused):** The transcript + editor context + terminal history is sent to **Groq** (default: Kimi K2) or **Cerebras** (default: Qwen 3 235B). You can choose from multiple models per provider via the Model dropdown in the sidebar. Thinking/reasoning is automatically suppressed for maximum speed (Qwen models get `/no_think`, GPT-OSS models use `reasoning_effort: low`). The LLM classifies the instruction and returns one of five types:
   - **command** — runs a VS Code command (130+ supported)
   - **modification** — applies a small, targeted edit to the selected text (changes are highlighted in green/red). **Only available when you have text manually selected in the editor.** Without a selection, code-edit requests are routed to the agent or answered as a question instead.
   - **question** — shows the answer in a separate panel (only used when no agent is available or the user says "quick question"). When no agent is selected, a note suggests selecting one for better handling of complex requests.
   - **terminal** — translates natural language to a shell command and executes it
   - **agent** — forwards an intelligent, context-aware prompt to Claude Code. This is the default for any non-trivial task when an agent is active, and also handles code-edit requests when no text is selected. When no agent is selected, agent-type requests fall back to the quick question system.
4. **Pre-LLM shortcuts:** Common phrases like "undo", "save", "scroll down", "enter", "delete", "focus editor", "ask Claude ...", keyboard shortcuts, and symbol navigation ("go to the handleCommand function") are handled instantly without waiting for the LLM. Semantic go-to ("go to the function that resets the board") uses a lightweight LLM call only when fuzzy name matching isn't confident enough.

---

## Setup

### 1) Install Mantra from the VS Code Marketplace

### 2) Provide API keys on first run

- **Deepgram** — speech-to-text (streaming). Get a key at https://deepgram.com (free $200 credit).
- **AssemblyAI** (optional) — speech-to-text (streaming or batch). Get a key at https://www.assemblyai.com/dashboard. Select "AssemblyAI" from the STT provider dropdown in the sidebar.
- **Aqua Voice** (optional) — speech-to-text (batch). Get a key at https://app.aquavoice.com/api-dashboard. Select "Aqua Voice" from the STT provider dropdown in the sidebar.
- **Groq** (recommended) or **Cerebras** — LLM routing. Get a key at https://console.groq.com or https://cloud.cerebras.ai

You'll be prompted the first time. Keys are stored in VS Code Secret Storage and can also be entered in the sidebar API Keys section.

### 3) Start!

Run **"Mantra: Start Recording"** from the Command Palette, press `Ctrl+Shift+1`, or click **Hands-Free Mode** in the Mantra sidebar panel (activity bar icon).

---

## What You Can Say

### Code editing (VS Code focused, requires text selection)
Code edits only happen when you have text selected in the editor — either selected manually or via a voice "select" command (see below). Select the lines you want to change, then speak:
- "change this to a while loop"
- "rename this variable to count"
- "add a docstring to this function"
- "remove the comments"
- "for i in range len nums print nums i" (raw code dictation)

Without a selection, code-edit requests are routed to the agent (if active) or answered as a question.

### Voice selection (VS Code focused)
Say "select" to select code by description, then follow up with an edit:
- "select this function" → selects the enclosing function
- "select the inner for loop" → selects just the nested loop, not the outer one
- "select the if statement" → selects the full if/elif/else chain
- "highlight the try block" → selects the try/except block
- "select lines 10 to 20" → selects exact line range

Once selected, your next voice command can edit it: "select this function" → "add a docstring" performs the edit on the selected code.

### Agent tasks (VS Code focused)
When an agent is active, complex or unselected code tasks go to the agent automatically:
- "create a terminal-based tic tac toe game"
- "add a helper function to validate user input"
- "add authentication"
- "refactor this to use async/await"

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

### Symbol navigation (VS Code focused)
Navigate directly to any function, class, method, or symbol in the current file:

- **By name:** "go to the handleCommand function", "go to function processActivityFile", "jump to class GameBoard"
- **By description (semantic):** "go to the function that resets the board", "go to the error handler", "jump to the input validation function"

Name-based matching uses fast token fuzzy matching (no LLM call). If the name doesn't match closely enough, or if you describe what a symbol does instead of saying its name, Mantra falls back to an LLM-powered semantic match — it sends the list of symbol names in the file to the LLM and picks the best match. This means "go to the function that checks if a move is valid" can find `is_valid_move` even though the words don't overlap.

**Relative navigation** also works via the LLM: "go to the next else if", "jump to the catch block" — the LLM finds the target line in the visible code and navigates there.

### Opening files
- "open script dot py" → opens `script.py`
- "open main" → fuzzy-matches `main.py`, `main.ts`, etc.
- "open auth dot controller dot ts" → opens `auth.controller.ts`

File names are fuzzy-matched against the workspace. You can say the extension ("dot py") or omit it — Mantra will find the closest match. When VS Code is focused, "open X" tries to match a workspace file first; only if no file matches does it try to open a macOS app.

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

## Agent Integration (Claude Code)

Mantra supports **Claude Code** as an AI agent backend via the [Claude Code VS Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code). Select **Claude Code** from the **Agent** dropdown in the sidebar Settings section. The `claude` CLI must be in your PATH.

When an agent is active, it becomes the **default destination** for any non-trivial request and for all code-edit requests when no text is selected. You don't need to say "ask Claude" — just speak naturally and tasks are automatically routed to the agent. If you have text selected in the editor, small edits ("change this to a while loop", "rename this variable") go through the fast modification path; otherwise they go to the agent.

When no agent is selected (**None**), code-edit requests without a selection are answered via the quick question system (with a note suggesting you select an agent). With text selected, modifications still work directly regardless of agent selection.

### Sending prompts to the agent
Say "ask Claude to refactor this function", "ask agent how to fix that", or "ask LLM to explain this error". When "Send Context to Agent" is enabled, the current editor state (filename, cursor position, selected text), activity log, terminal history, and workspace file listing are written to a context file that the agent can reference.

You can also just say what you want without mentioning any agent — "add an AI opponent", "improve the performance", "add authentication" — and it will be routed to the agent automatically.

Common phrases like "ask Claude ...", "ask agent ...", "ask LLM ...", "ask AI ..." are intercepted before the LLM for instant routing. These also work when VS Code is not focused.

### When the agent is running (VS Code focused)
While the agent terminal is active:
- **Commands still work normally** — "save file", "undo", "focus terminal" all execute as usual
- **Questions and conversation go to the agent** — "how do I fix this error?" types into the agent
- **"enter"** — presses Enter (confirms permission prompts, submits input)
- **"up" / "down"** — arrow keys for navigating selection menus
- **"yes" / "ok" / "go ahead"** — confirms the current selection
- **"focus editor" / "go back"** — switches back to the editor
- **"focus agent" / "open claude"** — switches to (or opens) the agent terminal

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
  - **Agent** — choose Claude Code or None.
  - **LLM Provider** — Groq (default) or Cerebras
  - **Model** — select the LLM model. Options update based on the selected provider. Defaults: Kimi K2 Instruct (Groq), Qwen 3 235B A22B (Cerebras). Thinking/reasoning is automatically minimized for all models.
  - **STT Provider** — Deepgram (streaming), AssemblyAI (streaming or batch), or Aqua Voice (batch)
  - **Silence Timeout** — (Aqua Voice / AssemblyAI batch only) how many seconds of silence before auto-transcribing. Default: 2s.
  - **Sensitivity** — (Aqua Voice / AssemblyAI batch only) microphone sensitivity for silence detection: Low (noisy environments), Medium (default), High (quiet environments).
  - **Microphone** — pick your input device. Changing the microphone while recording stops the current session (without transcribing) so the new mic is used on next start.
  - **Commands-Only Mode** — toggle with ON/OFF indicator (see below)
  - **Send Context to Agent** — toggle ON/OFF. When enabled (default), editor state (filename, cursor, selection), activity log, terminal history, and workspace files are written to a temp file and referenced in prompts sent to the agent. Turn off to send only the raw transcript.
  - **All Settings** / **Keyboard Shortcuts**
- **API Keys** — configure Deepgram, AssemblyAI, Aqua Voice, Groq, and Cerebras keys
- **Router Prompt** — view and edit the main LLM system prompt directly in the sidebar

---

## Commands-Only Mode

Toggle via the sidebar or Command Palette. When enabled (shown as **ON** in the sidebar):

- **No LLM calls** — speech is still transcribed via your selected STT provider, but the transcript is only matched against pre-mapped commands and text operations.
- **What works:** all 130+ IDE commands ("save", "undo", "format document"), text operations ("go to line 20", "select lines 4 to 19", "scroll down", "delete line"), keyboard shortcuts ("command B"), system commands, focus/navigation commands, and pause/resume.
- **What doesn't work:** code edits, questions, terminal command generation, and agent forwarding — anything that requires the LLM to interpret intent.

This is useful for low-latency command execution without any API calls beyond speech-to-text, or when you don't have an LLM API key configured.

---

## Agent Context

When "Send Context to Agent" is enabled (the default), Mantra writes a context file before each agent prompt containing:
- **Editor state** — current filename, language, cursor position, selected text (if any)
- **Activity log** — timestamped history of commands, edits, and transcripts
- **Terminal history** — recent shell commands and their output
- **Workspace files** — listing of files and folders in the project

The first message to the agent includes a preamble explaining what Mantra is, prepended before the user's transcript, with a reference to the context file. Follow-up messages send just the raw transcript (the context file is still updated each time).

**Selection model:** When the transcript contains a selection keyword ("select", "highlight", "lines X to Y"), Mantra runs a separate lightweight LLM call to determine the exact lines to select — "select the inner for loop", "select this function", "highlight the try block". This lets you say what you want to select in natural language with precision, including nested constructs. The selection model only runs when triggered by these keywords; all other utterances go straight to the main router. Code modifications require a selection (either manual or set by a prior "select" command).

The router and selection model prompts are visible and editable in the sidebar panel.

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

All shortcuts can be customized in **File > Preferences > Keyboard Shortcuts** (search "mantra"), or via the Keyboard Shortcuts button in the sidebar.

---

## Settings

Open **Settings > Extensions > Mantra** to adjust:

- **Agent Backend** — Choose between **Claude Code** or **None**.
- **LLM Provider** — Choose between **Groq** (default) or **Cerebras**.
- **Model** — Choose which model to use for the selected provider. Defaults: **Kimi K2 Instruct** (Groq), **Qwen 3 235B A22B** (Cerebras). Leave empty for the default. Thinking/reasoning is automatically suppressed for speed (`/no_think` for Qwen models, `reasoning_effort: low` for GPT-OSS).
- **STT Provider** — Choose between **Deepgram** (streaming, default), **AssemblyAI** (streaming or batch), or **Aqua Voice** (batch).
- **Silence Timeout** — (Aqua Voice / AssemblyAI batch only) Seconds of silence before auto-transcribing. Default: 2s.
- **Reasoning Effort** — Low (default), medium, or high. Controls thinking depth for models that support it (GPT-OSS).
- **Prompt** — Customize the LLM system prompt (also editable in the sidebar).
- **Commands Only** — Bypass the LLM entirely. Only pre-mapped commands and text operations work.
- **Send Context to Agent** — Include activity log and terminal history when sending prompts to the AI agent. Default: on.
- **Microphone Input** — Set via Command Palette > "Mantra: Select Microphone". Advanced users can paste raw FFmpeg input args.

---

## Supported Models

Select your preferred model from the **Model** dropdown in the sidebar. The list updates based on the selected LLM provider.

### Cerebras
| Model | Notes |
|-------|-------|
| **Qwen 3 235B A22B** (default) | 235B MoE (22B active). Best quality + speed balance. 100% routing accuracy, 222ms avg latency. Thinking auto-suppressed. |
| GPT-OSS 120B | OpenAI open-source 120B. Reasoning effort set to low. |
| Llama 3.1 8B | Fast, lightweight. Best for commands-only or low-complexity tasks. |
| ZAI GLM 4.7 | GLM-family model. |

### Groq
| Model | Notes |
|-------|-------|
| **Kimi K2 Instruct** (default) | 1T MoE. Fastest TTFT (~133ms). Strong routing and terminal accuracy. |
| Kimi K2 Instruct 0905 | Variant of K2. Slightly faster, slightly less accurate on complex routing. |
| Qwen 3 32B | Solid quality but may hit token limits on large files. Thinking auto-suppressed. |
| Llama 3.3 70B Versatile | High quality (81%) but higher latency (~484ms). |
| GPT-OSS 120B | OpenAI open-source 120B. Reasoning effort set to low. |
| GPT-OSS 20B | Lighter GPT-OSS variant. |
| GPT-OSS Safeguard 20B | GPT-OSS with safety guardrails. |
| Llama 3.1 8B Instant | Ultra-fast, lightweight. |
| Llama 4 Scout 17B | Meta's Llama 4 Scout. |
| Groq Compound | Groq's compound model with tool use. |
| Groq Compound Mini | Lighter compound variant. |
| Allam 2 7B | Arabic-focused model. |

---

## Privacy and Data Handling (Important)

- **Your responsibility:** Do not dictate passwords, tokens, or proprietary text you don't want transmitted. Pause listening when working with sensitive files. DO NOT USE MANTRA WHEN EDITING FILES WITH SENSITIVE CREDENTIALS. If Mantra detects sensitive information in your file, it will warn you before sending it to the LLM.
- **What goes to the speech model:** The most frequent identifiers from your open file are sent as keyterms to Deepgram, AssemblyAI, or Aqua Voice to bias recognition toward your code's vocabulary. No full source code is sent. When using Aqua Voice or AssemblyAI batch mode, the full audio recording is sent as a file for batch transcription.
- **What goes to the LLM:** The current file's full contents, file name, cursor context, and terminal history.
- **Secrets & storage:** API keys are stored in VS Code Secret Storage. No keys are written to disk in plaintext.
- **For more:** See Deepgram's, AssemblyAI's, and Groq's/Cerebras's privacy policies. Other than the API usage described above, Mantra runs entirely locally and does not collect, save, or share any of your data.

---

## Troubleshooting

- **No mic on macOS** — Allow VS Code under *System Settings > Privacy & Security > Microphone*.
- **Mouse click not working** — Allow VS Code under *System Settings > Privacy & Security > Accessibility*.
- **"Command not found: claude"** — Add the CLI to your PATH: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`
- **Ghost transcriptions ("two", "four")** — These are filtered automatically. If ambient noise is high, consider adjusting your microphone position.
- **File not found** — Include punctuation words when speaking filenames: "open auth dot controller dot ts". You can also just say the name without an extension ("open script") and Mantra will fuzzy-match it.
- **Logs** — Check **View > Output > Mantra** for detailed logs including which microphone is being used. The sidebar Activity Log also shows a history of all transcripts and actions.

---

## Supported IDE Commands (VS Code Focused)

Over 130 pre-mapped VS Code commands. You can say these exactly or use natural variations (the LLM understands intent):

> save, save all, new file, close file, close other files, close all files, reopen closed editor, undo, redo, cut, copy, paste, select all, toggle line comment, toggle block comment, format document, format selection, rename symbol, quick fix, organize imports, expand selection, shrink selection, select next occurrence, duplicate line down, duplicate line up, move line up, move line down, add cursor above, add cursor below, fold all, unfold all, toggle word wrap, find, replace, find in files, replace in files, next tab, previous tab, tab one through tab nine, page up, page down, go to definition, peek definition, go to references, go to implementation, jump to bracket, focus editor, focus first editor, focus second editor, focus sidebar, focus panel, toggle output, toggle sidebar, toggle panel, toggle zen mode, split editor, toggle minimap, zoom in, zoom out, reset zoom, toggle terminal, focus terminal, new terminal, next terminal, previous terminal, focus agent, new conversation, accept changes, reject changes, focus explorer, focus search, focus source control, focus debug, focus extensions, show command palette, quick open, toggle breakpoint, start debugging, stop debugging, continue debugging, step over, step into, step out, stage file, stage all, unstage file, commit, push, pull, checkout branch, show diff, stash, pop stash, toggle fullscreen, show problems, show notifications, clear notifications, reveal in finder, copy file path, copy relative path, markdown preview, run task, run build task, run test task, clear terminal, terminal scroll up, terminal scroll down.

Additional text operations handled directly (no LLM needed): go to line N, go to symbol by name ("go to function X"), select/copy/cut/delete line N, select/copy/cut/delete lines A to B, scroll up/down [N lines/pages], page up/down, new line above/below, indent, outdent, delete, paste, kill process, tab complete, run last command.

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

## Testing

Run the end-to-end LLM test suite to verify prompt quality across selection model, semantic go-to, and router:

```bash
# Groq (default)
GROQ_API_KEY=gsk_... npm run test:llm

# Cerebras
LLM_PROVIDER=cerebras CEREBRAS_API_KEY=csk_... npm run test:llm
```

The test harness (`test-llm.mjs`) makes real API calls using the exact prompts from `package.json` against realistic code samples. It covers 52 scenarios: 19 selection model tests (including 9 nested construct precision tests), 12 semantic go-to tests, and 21 router tests (across all 4 routing modes: with/without selection, with/without agent).

---

## Notes

- FFmpeg is used automatically if available; there is nothing extra to install.
- The extension loads after VS Code startup; listening begins only when you invoke **Mantra: Start Recording**.
- All voice control executes standard VS Code commands or safe editor edits; you can always undo changes on your own or just say "undo".
- System commands (mouse, app switching, browser navigation, etc.) are macOS only.
