# Mantra

Code with your thoughts, not your keyboard. Extremely accurate, absurdly fast.

Mantra listens to your instructions and instantly either edits your code ("add a helper function to handle my database queries"), runs an IDE command ("undo"), or answers your question about the code ("how do I make sure this is thread-safe?").

Get started for free!

Demo: https://youtu.be/ZSNIh9Qce8w

Discord: https://discord.gg/fmWCScWuUn

> Please read the Privacy and Data Handling section before use. Use a good quality and well-positioned desktop microphone for best results.

---

## What it does

- **Listen & auto-stop:** The audio is streamed to **Deepgram** with a small keyterm list (editor verbs, command phrases, language keywords, and identifiers from the open file) to bias phrase recognition. Mantra can be paused at any time.
- **Classify with LLM:** Sends the transcript + minimal editor context (including the full file content) to **Groq**. The LLM returns a type:
  - **command** → runs the VS Code command (over 75 to choose from)
  - **modification** → applies the edit the model specifies to the current file (LLM code modifications are highlighted temporarily in green and red for new and deleted lines respectively)
  - **question** → shows the answer in a separate panel

See below for examples.

---

## Setup (takes <4 minutes)
### 1) Install Mantra from the VS Code Marketplace

### 2) Provide API keys on first run

- **Deepgram** — speech‑to‑text (free since you get $200 free credit and it's extremely cheap, so it'll last months). Get it at https://deepgram.com
- **Groq** — LLM for processing user instructions (free, can use paid account for higher rate/token limits if needed). Get it at https://groq.com

You’ll be prompted the first time; keys are stored in VS Code Secret Storage. You can update them later via the same prompt sequence.

### 3) Start!

- Run **“Mantra: Start Recording”** (Command Palette) or use the keyboard shortcut (below).  
- Speak short phrases like:
  - “**create a terminal based tic tac toe game**”
  - “**what does this function do?**”
  - “**change this to a while loop**”
  - “**put getters and setters**”
  - “**create a helper function to validate the user input**”
  - “**undo**”
  - “**select lines 4 to 19**”
  - “**for i in range len nums print nums i**”
  - “**new line above**”
  - “**open utils dot java**”

**Pause / Resume:** say “pause” / “resume”, or run **Mantra: Pause Listening** / **Mantra: Resume Listening**. See keyboard shortcuts below.

---

## Commands & Keyboard Shortcuts

- **Start Recording** — `Ctrl+Shift+1`  
- **Pause Listening** — `Ctrl+Shift+2`  
- **Resume Listening** — `Ctrl+Shift+3`  
- **Configure Listening Sensitivity** — (Command Palette)

---

## Settings (tune for your mic/environment)
- **Trailing silence (ms)** — default **300**: how long of silence ends the clip (raise to avoid cut‑offs).

Open **Settings → Extensions → Mantra** to adjust.

---

## Privacy and Data Handling (Important)

- **Your responsibility:** Avoid dictating passwords, tokens, or proprietary text you do not want transmitted. Disconnect the keys or pause listening if you need to work offline. DO NOT USE MANTRA WHEN EDITING FILES WITH SENSITIVE INFORMATION SUCH AS CREDENTIALS OR API KEYS. Such information will be sent to the LLM. If Mantra detects that your file may have sensitive information (using regex pattern matching), it will warn you before sending the text to the LLM. Note that this may not catch all cases.
- **What hints are sent to the speech model:** A small list of **keyterms** (command phrases, language keywords, and **identifiers pulled from the current file**) is sent to Deepgram to bias recognition. This list contains words/phrases—not full source code.
- **When the LLM is used:** Mantra includes the **current file's full code** as context for the model. Mantra also provides a list of all file names to the model.
- **Secrets & storage:** Your API keys are stored securely in VS Code **Secret Storage**. No keys are written to disk in plaintext by the extension.
- **On‑screen content:** Transcripts and actions may appear briefly as status messages in VS Code.
- **For more:** See Deepgram and Groq's privacy policies. **Other than the Deepgram and Groq API usage, Mantra is executed locally on your computer as a VS Code extension and does not collect, save, or share any of your data.** You can set zero data retention for Groq here https://console.groq.com/settings/data-controls.

---

## Troubleshooting
 
- **No mic on macOS** — Allow **Visual Studio Code** under *System Settings → Privacy & Security → Microphone*.  
- **Clipped transcripts** — Increase *Trailing silence (ms)* (e.g., 1000–1500) or lower the *Silence threshold* (e.g., −40).  
- **File not found** — Include punctuation words when speaking filenames: “**open auth dot controller dot ts**”.

---

## Commands

If the user instruction is exactly equivalent to a premapped VS Code command (ie "redo"), Mantra may be able to execute that instead of checking with the LLM to see if the instruction is a command, what command would it be. However, if the user were to say something like "actually let's redo that", the LLM would be used to classify this as a command and so that the redo could be executed.

Here's a list of all of the IDE commands that Mantra currently supports. Some commands, such as cut, copy, paste, *may not* work reliably yet.

> add breakpoint, add cursor above, add cursor below, add next occurrence, back, block comment, close editor, close file, command palette, continue, continue debugging, copy, copy selection, create file, cut, cut selection, duplicate line, duplicate line down, duplicate line up, duplicate lines up, expand selection, find, find and replace, find in editor, find in files, first tab, fix, focus debug, focus explorer, focus extensions, focus search, focus source control, focus terminal, fold all, format document, format file, format selection, forward, go back, go forward, go to definition, go to implementation, go to references, goto definition, jump to bracket, line comment, minimap, move line down, move line up, move lines down, move lines up, new file, new terminal, next editor, next tab, open file, organize imports, page down, page up, panel, peek definition, prev tab, previous tab, quick fix, quick open, redo, rename, rename symbol, reopen closed editor, reopen closed tab, replace, replace in files, reset zoom, save, save all, save all files, save file, scroll down one page, scroll up one page, second tab, select all, select next occurrence, show command palette, show debug, show explorer, show extensions, show references, show search, show source control, shrink selection, sidebar, split editor, start debugging, step into, step out, step over, stop debugging, tab eight, tab five, tab four, tab nine, tab one, tab seven, tab six, tab three, tab two, terminal, toggle block comment, toggle breakpoint, toggle line comment, toggle minimap, toggle panel, toggle sidebar, toggle terminal, toggle word wrap, toggle zen mode, undo, unfold all, word wrap, zen mode, zoom in, zoom out, zoom reset.

---

## Notes

- FFmpeg is used automatically if available; there is nothing extra to install.  
- The extension loads after VS Code startup; listening begins only when you invoke **Mantra: Start Recording**.  
- All voice control executes standard VS Code commands or safe editor edits; you can always undo changes on your own or just say "undo".