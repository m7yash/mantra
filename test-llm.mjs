#!/usr/bin/env node
/**
 * Mantra LLM E2E Test Harness
 *
 * Tests the selection model, semantic go-to, and router with real LLM API calls.
 * Uses the exact prompts from package.json.
 *
 * Usage:
 *   GROQ_API_KEY=gsk_... node test-llm.mjs
 *   LLM_PROVIDER=cerebras CEREBRAS_API_KEY=csk_... node test-llm.mjs
 *   LLM_MODEL=llama-3.3-70b-versatile GROQ_API_KEY=gsk_... node test-llm.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Extract prompts from package.json ────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const props = pkg.contributes.configuration.properties;
const SELECTION_PROMPT = props['mantra.selectionPrompt'].default;
const ROUTER_PROMPT = props['mantra.prompt'].default;

// ── Config ───────────────────────────────────────────────────────────────────

const PROVIDER = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
const CEREBRAS_MODEL_DEFAULT = 'qwen-3-235b-a22b-instruct-2507';
const GROQ_MODEL_DEFAULT = 'moonshotai/kimi-k2-instruct';
const MODEL = process.env.LLM_MODEL || (PROVIDER === 'cerebras' ? CEREBRAS_MODEL_DEFAULT : GROQ_MODEL_DEFAULT);
const API_KEY = PROVIDER === 'cerebras'
  ? (process.env.CEREBRAS_API_KEY || '')
  : (process.env.GROQ_API_KEY || '');

const NO_THINK_MODELS = new Set([
  'qwen-3-235b-a22b-instruct-2507',
  'qwen/qwen3-32b',
]);

if (!API_KEY) {
  console.error(`Missing API key. Set ${PROVIDER === 'cerebras' ? 'CEREBRAS_API_KEY' : 'GROQ_API_KEY'} env var.`);
  process.exit(1);
}

// ── LLM call (mirrors model.ts chatText) ─────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function chatText(messages, { temperature = 0 } = {}) {
  // Append /no_think for Qwen models
  if (NO_THINK_MODELS.has(MODEL)) {
    messages = messages.map((m, i) => {
      if (m.role === 'user' && i === messages.length - 1) {
        return { ...m, content: m.content + '\n\n/no_think' };
      }
      return m;
    });
  }

  if (PROVIDER === 'cerebras') {
    const Cerebras = (await import('@cerebras/cerebras_cloud_sdk')).default;
    const client = new Cerebras({ apiKey: API_KEY });
    const res = await client.chat.completions.create({
      model: MODEL, temperature, messages,
    });
    return (res?.choices?.[0]?.message?.content ?? '').trim();
  }

  // Groq
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, temperature, messages }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Groq ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  return (json?.choices?.[0]?.message?.content ?? '').trim();
}

// ── Sample code files ────────────────────────────────────────────────────────

const SAMPLE_FILES = {
  pythonIfElse: {
    filename: 'classifier.py',
    language: 'python',
    content: `import sys

def classify_temperature(temp):
    """Classify a temperature reading."""
    result = []

    # Validate input
    if not isinstance(temp, (int, float)):
        raise TypeError("Expected a number")

    if temp < -40:
        category = "extreme_cold"
        alert = True
        message = "Dangerously cold"
    elif temp < 0:
        category = "freezing"
        alert = False
        message = "Below freezing"
    elif temp < 15:
        category = "cold"
        alert = False
        message = "Cold weather"
    elif temp < 25:
        category = "comfortable"
        alert = False
        message = "Comfortable"
    elif temp < 35:
        category = "warm"
        alert = False
        message = "Warm weather"
    elif temp < 45:
        category = "hot"
        alert = True
        message = "Very hot"
    else:
        category = "extreme_heat"
        alert = True
        message = "Dangerously hot"

    return {"category": category, "alert": alert, "message": message}

def format_report(data):
    """Format a temperature report."""
    lines = []
    for entry in data:
        lines.append(f"{entry['category']}: {entry['message']}")
    return "\\n".join(lines)

if __name__ == "__main__":
    temps = [int(x) for x in sys.argv[1:]]
    for t in temps:
        print(classify_temperature(t))`,
  },

  pythonClass: {
    filename: 'game.py',
    language: 'python',
    content: `class GameBoard:
    """A tic-tac-toe game board."""

    def __init__(self, size=3):
        self.size = size
        self.board = [[None] * size for _ in range(size)]
        self.current_player = "X"
        self.move_count = 0

    def reset_board(self):
        """Clear the board and reset game state."""
        self.board = [[None] * self.size for _ in range(self.size)]
        self.current_player = "X"
        self.move_count = 0

    def make_move(self, row, col):
        """Place a piece on the board."""
        if not self.is_valid_move(row, col):
            raise ValueError(f"Invalid move: ({row}, {col})")
        self.board[row][col] = self.current_player
        self.move_count += 1
        self.current_player = "O" if self.current_player == "X" else "X"

    def is_valid_move(self, row, col):
        """Check if a move is within bounds and the cell is empty."""
        if row < 0 or row >= self.size or col < 0 or col >= self.size:
            return False
        return self.board[row][col] is None

    def get_winner(self):
        """Check rows, columns, and diagonals for a winner."""
        for i in range(self.size):
            if self.board[i][0] and all(self.board[i][j] == self.board[i][0] for j in range(self.size)):
                return self.board[i][0]
            if self.board[0][i] and all(self.board[j][i] == self.board[0][i] for j in range(self.size)):
                return self.board[0][i]
        if self.board[0][0] and all(self.board[i][i] == self.board[0][0] for i in range(self.size)):
            return self.board[0][0]
        if self.board[0][-1] and all(self.board[i][self.size - 1 - i] == self.board[0][-1] for i in range(self.size)):
            return self.board[0][-1]
        return None

    def display(self):
        """Print the board to stdout."""
        for row in self.board:
            print(" | ".join(cell or " " for cell in row))
            print("-" * (self.size * 4 - 1))


def main():
    game = GameBoard()
    game.display()
    game.make_move(0, 0)
    game.make_move(1, 1)
    game.display()
    winner = game.get_winner()
    if winner:
        print(f"Winner: {winner}")
    else:
        print("No winner yet")


if __name__ == "__main__":
    main()`,
  },

  jsModule: {
    filename: 'server.js',
    language: 'javascript',
    content: `const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

function validateInput(data) {
  const errors = [];
  if (!data.name || typeof data.name !== 'string') {
    errors.push('Name is required and must be a string');
  }
  if (!data.email || !data.email.includes('@')) {
    errors.push('Valid email is required');
  }
  if (data.age !== undefined && (typeof data.age !== 'number' || data.age < 0)) {
    errors.push('Age must be a positive number');
  }
  return errors;
}

function processActivityFile(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const lines = raw.split('\\n').filter(Boolean);
  const activities = lines.map(line => {
    const [timestamp, action, user] = line.split(',');
    return { timestamp, action, user: user?.trim() };
  });
  return activities;
}

function handleError(err, req, res, next) {
  console.error('Server error:', err.stack);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    code: status,
  });
}

app.post('/api/users', (req, res) => {
  const errors = validateInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }
  res.status(201).json({ id: Date.now(), ...req.body });
});

app.get('/api/activity', (req, res) => {
  const activities = processActivityFile(path.join(__dirname, 'activity.log'));
  res.json(activities);
});

app.use(handleError);

function main() {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(\`Server running on port \${port}\`);
  });
}

main();`,
  },

  tsService: {
    filename: 'user-service.ts',
    language: 'typescript',
    content: `interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
  createdAt: Date;
}

interface CreateUserInput {
  name: string;
  email: string;
  role?: 'admin' | 'user' | 'guest';
}

class UserService {
  private users: Map<string, UserProfile> = new Map();

  createUser(input: CreateUserInput): UserProfile {
    const id = crypto.randomUUID();
    const user: UserProfile = {
      id,
      name: input.name,
      email: input.email,
      role: input.role || 'user',
      createdAt: new Date(),
    };
    this.users.set(id, user);
    return user;
  }

  findUserById(id: string): UserProfile | undefined {
    return this.users.get(id);
  }

  updateUser(id: string, updates: Partial<CreateUserInput>): UserProfile {
    const user = this.users.get(id);
    if (!user) throw new Error(\`User \${id} not found\`);
    if (updates.name) user.name = updates.name;
    if (updates.email) user.email = updates.email;
    if (updates.role) user.role = updates.role;
    return user;
  }

  deleteUser(id: string): boolean {
    return this.users.delete(id);
  }

  listUsers(role?: string): UserProfile[] {
    const all = Array.from(this.users.values());
    if (role) return all.filter(u => u.role === role);
    return all;
  }
}

export { UserService, UserProfile, CreateUserInput };`,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildNumberedFile(content) {
  const lines = content.split('\n');
  return lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
}

function buildSelectionUserMessage(utterance, cursorLine, file) {
  const numbered = buildNumberedFile(file.content);
  const lines = file.content.split('\n');
  return [
    `Voice command: "${utterance}"`,
    `Cursor: line ${cursorLine}, column 1`,
    `File: ${file.filename}`,
    `Language: ${file.language}`,
    `Total lines: ${lines.length}`,
    '',
    numbered,
  ].join('\n');
}

/**
 * Build the user message for the router LLM call.
 * @param {string} utterance
 * @param {object} file - { filename, language, content }
 * @param {number} cursorLine
 * @param {{ startLine: number, endLine: number }} [selection] - optional pre-existing selection
 */
function buildRouterUserMessage(utterance, file, cursorLine, selection) {
  const lines = file.content.split('\n');
  const lineText = lines[cursorLine - 1] || '';
  const selectionText = selection
    ? lines.slice(selection.startLine - 1, selection.endLine).join('\n')
    : '';
  const parts = [
    'User utterance:',
    utterance,
    '',
    'Editor context:',
    `Active file language: ${file.language}`,
    `Total lines: ${lines.length}`,
    `Filename: ${file.filename}`,
    '',
    'Cursor summary:',
    `- line: ${cursorLine}, column: 1`,
    `- line text: ${lineText}`,
    `- selection: ${selectionText || '(none)'}`,
    '',
    '(no enclosing symbol)',
    '',
    'Full file contents (entire document):',
    '```',
    file.content,
    '```',
  ];

  // Append SELECTION MODE block when the user has text selected
  if (selection) {
    const startLine = selection.startLine;
    const endLine = selection.endLine;
    const selectedText = lines.slice(startLine - 1, endLine).join('\n');
    const selLines = selectedText.split('\n');
    let baseIndent = '';
    let minLen = Infinity;
    for (const line of selLines) {
      if (line.trim() === '') continue;
      const indent = (line.match(/^(\s*)/) ?? ['', ''])[1];
      if (indent.length < minLen) { minLen = indent.length; baseIndent = indent; }
    }
    const ctxBefore = startLine > 1
      ? lines.slice(Math.max(0, startLine - 4), startLine - 1).join('\n')
      : '(start of file)';
    const ctxAfter = endLine < lines.length
      ? lines.slice(endLine, Math.min(lines.length, endLine + 3)).join('\n')
      : '(end of file)';
    const indentDesc = baseIndent.length === 0 ? 'no indentation'
      : baseIndent.includes('\t') ? `${baseIndent.length} tab(s)`
      : `${baseIndent.length} spaces`;

    parts.push('');
    parts.push('\u26a0\ufe0f SELECTION MODE \u26a0\ufe0f');
    parts.push(`The user has lines ${startLine}–${endLine} selected. For a modification, output ONLY the replacement for the selected text — do NOT output the entire file. The full file above is for context only.`);
    parts.push('');
    parts.push(`Selected text (lines ${startLine}–${endLine}, to be replaced):`);
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
  }

  return parts.join('\n');
}

const COMMAND_LIST = 'save, save file, save all, new file, close file, close tab, close all, undo, redo, cut, copy, paste, select all, format document, rename symbol, find, replace, next tab, previous tab, go to definition, go to references, toggle terminal, focus terminal, new terminal, toggle sidebar, toggle panel, zoom in, zoom out, show command palette, quick open, toggle breakpoint, start debugging, stop debugging, next error, previous error, show hover, go to symbol, stage file, commit, push, pull';

/**
 * Build the system prompt for router tests matching the 4-way agentNote matrix.
 * @param {{ hasAgent: boolean, hasSelection: boolean }} opts
 */
function buildRouterSystemPrompt({ hasAgent = true, hasSelection = false } = {}) {
  let agentNote;
  if (hasAgent && hasSelection) {
    agentNote = '\nIMPORTANT — An AI agent (Claude Code) is active and the user has text selected. Prefer "agent" over "modification" for anything non-trivial. Use "modification" ONLY for small, targeted edits on the selected text (rename a variable, change a loop type, add a single line, remove a comment, etc.). For anything that requires thought, planning, multi-step work, new features, refactoring, or is even slightly complex, use "agent". When ambiguous, default to "agent". NEVER use "question" to answer something the agent could handle — "question" is ONLY for quick factual answers when no agent is available or the user explicitly asks a brief knowledge question like "what does this line do?".';
  } else if (hasAgent && !hasSelection) {
    agentNote = '\nIMPORTANT — An AI agent (Claude Code) is active. The user has NO text selected in the editor, so the "modification" type is NOT available — NEVER output "modification". Only "command", "terminal", "agent", and "question" are valid output types. For ANY code editing request (rename a variable, change a loop, add a line, etc.), use "agent" — the agent will handle it. When ambiguous, default to "agent". NEVER use "question" to answer something the agent could handle — "question" is ONLY for quick factual answers when the user explicitly asks a brief knowledge question like "what does this line do?".';
  } else if (!hasAgent && hasSelection) {
    agentNote = '\nIMPORTANT: No AI agent is active. The "agent" type is NOT available — NEVER output "agent" or "claude". The user has text selected, so "modification" is available for code edits on the selected text. Only "question", "command", "modification", and "terminal" are valid output types. For knowledge/explanation questions, use "question" and provide a helpful answer.';
  } else {
    agentNote = '\nIMPORTANT: No AI agent is active and the user has NO text selected. The "agent" type is NOT available — NEVER output "agent" or "claude". The "modification" type is also NOT available — NEVER output "modification" (no text is selected to edit). Only "question", "command", and "terminal" are valid output types. For code editing requests, use "question" and explain the changes the user should make. For knowledge/explanation questions, use "question" and provide a helpful answer.';
  }

  return ROUTER_PROMPT + agentNote
    + '\n\nCanonical command catalog (authoritative; choose ONLY from these when outputting type=command):\n'
    + COMMAND_LIST;
}

// ── Test cases ───────────────────────────────────────────────────────────────

// -- Selection model tests --

const selectionTests = [
  // --- Code edits → full (modification is handled by router, not selection model) ---
  {
    name: 'switch-conversion-full',
    utterance: 'make this a switch statement',
    cursorLine: 18,
    file: SAMPLE_FILES.pythonIfElse,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'add-docstring-full',
    utterance: 'add a docstring to this function',
    cursorLine: 21,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'rename-variable-full',
    utterance: 'rename this variable',
    cursorLine: 6,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'delete-line-full',
    utterance: 'delete this line',
    cursorLine: 15,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  // --- Selection commands → select (pure selection of code constructs) ---
  {
    name: 'select-entire-class',
    utterance: 'select the entire class',
    cursorLine: 20,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // GameBoard class spans lines 1-47
      return {
        pass: +start <= 1 && +end >= 47,
        detail: `select ${start} ${end} (expected select covering ~1-47)`,
      };
    },
  },
  // --- More code edits → full ---
  {
    name: 'code-dictation-full',
    utterance: 'x equals 5',
    cursorLine: 25,
    file: SAMPLE_FILES.jsModule,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'add-import-full',
    utterance: 'add an import for lodash',
    cursorLine: 2,
    file: SAMPLE_FILES.jsModule,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'change-loop-full',
    utterance: 'change this to a while loop',
    cursorLine: 42,
    file: SAMPLE_FILES.pythonIfElse,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'wrap-try-catch-full',
    utterance: 'wrap this in a try catch',
    cursorLine: 26,
    file: SAMPLE_FILES.jsModule,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'comment-function-full',
    utterance: 'comment out this function',
    cursorLine: 27,
    file: SAMPLE_FILES.jsModule,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      // "comment out" may be interpreted as full (editor command) or select (highlight first)
      if (trimmed === 'full') return { pass: true, detail: 'full' };
      const m = trimmed.match(/^select\s+(\d+)\s+(\d+)/);
      if (m && +m[1] <= 22 && +m[2] >= 30) return { pass: true, detail: `select ${m[1]} ${m[2]} (select interpretation)` };
      return { pass: false, detail: trimmed };
    },
  },
  {
    name: 'add-timeout-full',
    utterance: 'add a timeout parameter to this method',
    cursorLine: 22,
    file: SAMPLE_FILES.tsService,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  // --- Selection commands → select ---
  {
    name: 'select-interface',
    utterance: 'select this interface',
    cursorLine: 3, // inside UserProfile interface
    file: SAMPLE_FILES.tsService,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // UserProfile interface spans lines 1-7
      return {
        pass: +start <= 1 && +end >= 7,
        detail: `select ${start} ${end} (expected select covering ~1-7)`,
      };
    },
  },
  // --- More code edits → full ---
  {
    name: 'add-return-type-full',
    utterance: 'add a return type to this method',
    cursorLine: 38,
    file: SAMPLE_FILES.tsService,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'delete-method-full',
    utterance: 'delete this method',
    cursorLine: 45,
    file: SAMPLE_FILES.tsService,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      // "delete" may be interpreted as full (editor command) or select (highlight to delete)
      if (trimmed === 'full') return { pass: true, detail: 'full' };
      const m = trimmed.match(/^select\s+(\d+)\s+(\d+)/);
      if (m && +m[1] <= 44 && +m[2] >= 46) return { pass: true, detail: `select ${m[1]} ${m[2]} (select interpretation)` };
      return { pass: false, detail: trimmed };
    },
  },
  {
    name: 'code-dictation-loop-full',
    utterance: 'for i in range len nums',
    cursorLine: 22,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'make-async-full',
    utterance: 'make this function async',
    cursorLine: 26,
    file: SAMPLE_FILES.jsModule,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'add-error-handling-full',
    utterance: 'add error handling here',
    cursorLine: 26,
    file: SAMPLE_FILES.jsModule,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return { pass: trimmed === 'full', detail: trimmed };
    },
  },
  {
    name: 'run-file-full',
    utterance: 'run this file',
    cursorLine: 10,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return {
        pass: trimmed === 'full',
        detail: trimmed,
      };
    },
  },
  {
    name: 'question-full',
    utterance: 'what does this function do',
    cursorLine: 20,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return {
        pass: trimmed === 'full',
        detail: trimmed,
      };
    },
  },
  {
    name: 'select-lines-command',
    utterance: 'select lines 10 to 20',
    cursorLine: 15,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      // "select lines 10 to 20" — may be interpreted literally or as full (editor command)
      if (trimmed === 'full') return { pass: true, detail: 'full' };
      const m = trimmed.match(/^select\s+10\s+20/);
      if (m) return { pass: true, detail: 'select 10 20 (literal interpretation)' };
      return { pass: false, detail: trimmed };
    },
  },
  // --- Additional selection tests: robust construct selection ---
  {
    name: 'select-function-from-body',
    utterance: 'select this function',
    cursorLine: 21, // inside make_move body (line 21 is self.move_count += 1)
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // make_move spans lines 16-22. MUST include the def line (16), not start inside the body.
      return {
        pass: +start <= 16 && +end >= 22,
        detail: `select ${start} ${end} (expected select covering ~16-22, must include def header)`,
      };
    },
  },
  {
    name: 'select-method-from-deep-body',
    utterance: 'select the function',
    cursorLine: 30, // inside get_winner body
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // get_winner spans lines 30-41. Must include the def line (30).
      return {
        pass: +start <= 30 && +end >= 40,
        detail: `select ${start} ${end} (expected select covering get_winner ~30-41)`,
      };
    },
  },
  {
    name: 'select-js-function-from-body',
    utterance: 'select the function',
    cursorLine: 26, // inside processActivityFile body
    file: SAMPLE_FILES.jsModule,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // processActivityFile spans lines 22-30. Must include function header (22).
      return {
        pass: +start <= 22 && +end >= 29,
        detail: `select ${start} ${end} (expected select covering processActivityFile ~22-30)`,
      };
    },
  },
  {
    name: 'select-ts-method-from-body',
    utterance: 'select this method',
    cursorLine: 38, // inside updateUser body
    file: SAMPLE_FILES.tsService,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // updateUser spans lines 35-42. Must include method signature (35).
      return {
        pass: +start <= 35 && +end >= 41,
        detail: `select ${start} ${end} (expected select covering updateUser ~35-42)`,
      };
    },
  },
  {
    name: 'select-if-chain',
    utterance: 'select this if statement',
    cursorLine: 18, // inside elif branch
    file: SAMPLE_FILES.pythonIfElse,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // if/elif/else chain spans lines 11-36
      return {
        pass: +start <= 11 && +end >= 36,
        detail: `select ${start} ${end} (expected select covering if/elif/else ~11-36)`,
      };
    },
  },
  {
    name: 'select-the-loop',
    utterance: 'select the loop',
    cursorLine: 46, // inside for loop body in format_report (line 46 = lines.append)
    file: SAMPLE_FILES.pythonIfElse,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // The nearest loop is: for entry in data (lines 45-46).
      // The other loop is: for t in temps (lines 51-52).
      // Either is acceptable, though the cursor is inside the first.
      const coversNearLoop = +start <= 45 && +end >= 46;
      const coversOtherLoop = +start <= 51 && +end >= 52;
      return {
        pass: coversNearLoop || coversOtherLoop,
        detail: `select ${start} ${end} (expected a loop selection)`,
      };
    },
  },
  {
    name: 'highlight-constructor',
    utterance: 'highlight the constructor',
    cursorLine: 6, // inside __init__ body
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // __init__ spans lines 4-9. Must include the def line (4).
      return {
        pass: +start <= 4 && +end >= 8,
        detail: `select ${start} ${end} (expected select covering __init__ ~4-9)`,
      };
    },
  },
];

// -- Semantic go-to tests --

const SEMANTIC_GOTO_PROMPT = [
  'You are a code navigation assistant.',
  'Given a spoken description and a list of symbol names from a code file,',
  'return the EXACT name of the symbol that best matches the description.',
  'Output ONLY the symbol name, nothing else. No explanation, no quotes, no reasoning.',
  'If no symbol matches the description, output: NONE',
].join('\n');

const gameSymbols = ['__init__', 'reset_board', 'make_move', 'is_valid_move', 'get_winner', 'display', 'main'];
const jsSymbols = ['validateInput', 'processActivityFile', 'handleError', 'main'];
const tsSymbols = ['UserProfile', 'CreateUserInput', 'UserService', 'createUser', 'findUserById', 'updateUser', 'deleteUser', 'listUsers'];

const gotoTests = [
  { name: 'reset-board', description: 'the function that resets the board', symbols: gameSymbols, expected: 'reset_board' },
  { name: 'main-entry', description: 'the main entry point', symbols: jsSymbols, expected: 'main' },
  { name: 'error-handler', description: 'the function that handles errors', symbols: jsSymbols, expected: 'handleError' },
  { name: 'create-users', description: 'the method that creates users', symbols: tsSymbols, expected: 'createUser' },
  { name: 'input-validation', description: 'the input validation function', symbols: jsSymbols, expected: 'validateInput' },
  { name: 'valid-move-check', description: 'the function that checks if a move is valid', symbols: gameSymbols, expected: 'is_valid_move' },
  { name: 'display-board', description: 'the function that shows the board', symbols: gameSymbols, expected: 'display' },
  { name: 'activity-reader', description: 'the function that reads activity files', symbols: jsSymbols, expected: 'processActivityFile' },
  { name: 'find-by-id', description: 'the method for finding a user by ID', symbols: tsSymbols, expected: 'findUserById' },
  { name: 'remove-user', description: 'the method that removes a user', symbols: tsSymbols, expected: 'deleteUser' },
  { name: 'winner-check', description: 'the function that determines the winner', symbols: gameSymbols, expected: 'get_winner' },
  { name: 'constructor', description: 'the constructor', symbols: gameSymbols, expected: '__init__' },
];

// -- Router tests --
// Each test can specify hasAgent (default true) and hasSelection (default false).
// When hasSelection is set, a selection range is provided.

const routerTests = [
  // --- No selection, agent active (default) ---
  { name: 'save-file', utterance: 'save the file', file: SAMPLE_FILES.jsModule, cursorLine: 10, expectedType: 'command' },
  { name: 'run-python', utterance: 'run this file', file: SAMPLE_FILES.pythonClass, cursorLine: 10, expectedType: 'terminal' },
  { name: 'rename-variable-no-sel', utterance: 'rename this variable to count', file: SAMPLE_FILES.jsModule, cursorLine: 10, expectedType: 'command|agent' },
  { name: 'quick-question', utterance: 'quick question what does this function do', file: SAMPLE_FILES.pythonClass, cursorLine: 20, expectedType: 'question' },
  { name: 'git-status', utterance: 'check git status', file: SAMPLE_FILES.jsModule, cursorLine: 1, expectedType: 'terminal' },
  { name: 'undo', utterance: 'undo that', file: SAMPLE_FILES.jsModule, cursorLine: 10, expectedType: 'command' },
  { name: 'change-port-no-sel', utterance: 'change the port to 8080', file: SAMPLE_FILES.jsModule, cursorLine: 54, expectedType: 'agent' },
  { name: 'close-tab', utterance: 'close this tab', file: SAMPLE_FILES.jsModule, cursorLine: 1, expectedType: 'command' },
  { name: 'while-loop-no-sel', utterance: 'change this to a while loop', file: SAMPLE_FILES.pythonIfElse, cursorLine: 42, expectedType: 'agent' },
  { name: 'add-print-no-sel', utterance: 'add a print statement here', file: SAMPLE_FILES.jsModule, cursorLine: 26, expectedType: 'agent' },
  { name: 'make-async-no-sel', utterance: 'make this function async', file: SAMPLE_FILES.jsModule, cursorLine: 26, expectedType: 'agent' },
  { name: 'add-docstring-no-sel', utterance: 'add a docstring to this function', file: SAMPLE_FILES.pythonClass, cursorLine: 21, expectedType: 'agent' },
  { name: 'what-does-this-do', utterance: 'what does this function do', file: SAMPLE_FILES.pythonClass, cursorLine: 20, expectedType: 'agent|question' },

  // --- With selection, agent active ---
  { name: 'change-port-with-sel', utterance: 'change the port to 8080', file: SAMPLE_FILES.jsModule, cursorLine: 54,
    hasSelection: true, selection: { startLine: 54, endLine: 56 }, expectedType: 'modification' },
  { name: 'while-loop-with-sel', utterance: 'change this to a while loop', file: SAMPLE_FILES.pythonIfElse, cursorLine: 42,
    hasSelection: true, selection: { startLine: 39, endLine: 44 }, expectedType: 'modification' },
  { name: 'rename-var-with-sel', utterance: 'rename this variable to count', file: SAMPLE_FILES.jsModule, cursorLine: 10,
    hasSelection: true, selection: { startLine: 8, endLine: 19 }, expectedType: 'modification' },
  { name: 'add-docstring-with-sel', utterance: 'add a docstring to this function', file: SAMPLE_FILES.pythonClass, cursorLine: 21,
    hasSelection: true, selection: { startLine: 16, endLine: 23 }, expectedType: 'modification' },

  // --- No selection, no agent ---
  { name: 'change-port-no-agent', utterance: 'change the port to 8080', file: SAMPLE_FILES.jsModule, cursorLine: 54,
    hasAgent: false, expectedType: 'question' },
  { name: 'while-loop-no-agent', utterance: 'change this to a while loop', file: SAMPLE_FILES.pythonIfElse, cursorLine: 42,
    hasAgent: false, expectedType: 'question' },
  { name: 'run-file-no-agent', utterance: 'run this file', file: SAMPLE_FILES.pythonClass, cursorLine: 10,
    hasAgent: false, expectedType: 'terminal' },

  // --- With selection, no agent ---
  { name: 'change-port-sel-no-agent', utterance: 'change the port to 8080', file: SAMPLE_FILES.jsModule, cursorLine: 54,
    hasAgent: false, hasSelection: true, selection: { startLine: 54, endLine: 56 }, expectedType: 'modification' },
];

// ── Test runner ──────────────────────────────────────────────────────────────

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function runSelectionTests() {
  console.log(`\n${CYAN}--- Selection Model Tests (${selectionTests.length}) ---${RESET}\n`);
  let passed = 0, failed = 0, errors = 0;

  for (const test of selectionTests) {
    try {
      const user = buildSelectionUserMessage(test.utterance, test.cursorLine, test.file);
      const raw = await chatText([
        { role: 'system', content: SELECTION_PROMPT },
        { role: 'user', content: user },
      ]);
      const result = test.validate(raw);
      if (result.pass) {
        console.log(`  ${GREEN}PASS${RESET}  ${test.name}: ${DIM}${result.detail}${RESET}`);
        passed++;
      } else {
        console.log(`  ${RED}FAIL${RESET}  ${test.name}: ${result.detail}`);
        console.log(`        ${DIM}Raw: ${raw.slice(0, 80)}${RESET}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ${YELLOW}ERR ${RESET}  ${test.name}: ${err.message}`);
      errors++;
    }
    await sleep(300);
  }

  return { passed, failed, errors };
}

async function runGotoTests() {
  console.log(`\n${CYAN}--- Semantic Go-To Tests (${gotoTests.length}) ---${RESET}\n`);
  let passed = 0, failed = 0, errors = 0;

  for (const test of gotoTests) {
    try {
      const user = [
        `Description: "${test.description}"`,
        '',
        'Symbols in file:',
        ...test.symbols.map(n => `- ${n}`),
      ].join('\n');

      const raw = await chatText([
        { role: 'system', content: SEMANTIC_GOTO_PROMPT },
        { role: 'user', content: user },
      ]);

      const result = raw.trim();
      const match = result === test.expected
        || result.toLowerCase() === test.expected.toLowerCase();
      if (match) {
        console.log(`  ${GREEN}PASS${RESET}  ${test.name}: ${DIM}"${result}"${RESET}`);
        passed++;
      } else {
        console.log(`  ${RED}FAIL${RESET}  ${test.name}: expected "${test.expected}", got "${result}"`);
        failed++;
      }
    } catch (err) {
      console.log(`  ${YELLOW}ERR ${RESET}  ${test.name}: ${err.message}`);
      errors++;
    }
    await sleep(300);
  }

  return { passed, failed, errors };
}

async function runRouterTests() {
  console.log(`\n${CYAN}--- Router Tests (${routerTests.length}) ---${RESET}\n`);
  let passed = 0, failed = 0, errors = 0;

  for (const test of routerTests) {
    try {
      const hasAgent = test.hasAgent !== false; // default true
      const hasSelection = !!test.hasSelection;
      const system = buildRouterSystemPrompt({ hasAgent, hasSelection });
      const user = buildRouterUserMessage(test.utterance, test.file, test.cursorLine, test.selection);
      const raw = await chatText([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);

      const firstWord = raw.trim().split(/\s/)[0].toLowerCase();
      const validTypes = test.expectedType.split('|');
      const match = validTypes.includes(firstWord);
      const selLabel = hasSelection ? '+sel' : '-sel';
      const agentLabel = hasAgent ? '+agent' : '-agent';
      if (match) {
        console.log(`  ${GREEN}PASS${RESET}  ${test.name} [${selLabel},${agentLabel}]: ${DIM}${firstWord}${RESET}`);
        passed++;
      } else {
        console.log(`  ${RED}FAIL${RESET}  ${test.name} [${selLabel},${agentLabel}]: expected "${test.expectedType}", got "${firstWord}"`);
        console.log(`        ${DIM}Raw: ${raw.slice(0, 80)}${RESET}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ${YELLOW}ERR ${RESET}  ${test.name}: ${err.message}`);
      errors++;
    }
    await sleep(300);
  }

  return { passed, failed, errors };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${CYAN}=== Mantra LLM E2E Tests ===${RESET}`);
  console.log(`Provider: ${PROVIDER}, Model: ${MODEL}\n`);

  const t0 = Date.now();

  const sel = await runSelectionTests();
  const goto_ = await runGotoTests();
  const router = await runRouterTests();

  const total = {
    passed: sel.passed + goto_.passed + router.passed,
    failed: sel.failed + goto_.failed + router.failed,
    errors: sel.errors + goto_.errors + router.errors,
  };
  const totalTests = total.passed + total.failed + total.errors;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n${CYAN}=== Summary ===${RESET}`);
  console.log(`Passed: ${GREEN}${total.passed}${RESET} / ${totalTests}`);
  if (total.failed > 0) console.log(`Failed: ${RED}${total.failed}${RESET}`);
  if (total.errors > 0) console.log(`Errors: ${YELLOW}${total.errors}${RESET}`);
  console.log(`Time: ${elapsed}s\n`);

  process.exit(total.failed + total.errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
