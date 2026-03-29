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

  // Sample with nested constructs for precision selection testing
  pythonNested: {
    filename: 'matrix.py',
    language: 'python',
    content: `def process_matrix(matrix):
    """Process a matrix with nested loops."""
    result = []
    for i, row in enumerate(matrix):
        row_sum = 0
        for j, val in enumerate(row):
            if val > 0:
                row_sum += val
            else:
                row_sum -= val
        result.append(row_sum)
    return result

def find_pairs(nums, target):
    """Find all pairs that sum to target."""
    pairs = []
    for i in range(len(nums)):
        for j in range(i + 1, len(nums)):
            if nums[i] + nums[j] == target:
                pairs.append((nums[i], nums[j]))
    return pairs

def nested_conditionals(data):
    """Process data with nested conditionals."""
    output = []
    for item in data:
        if item.get("type") == "A":
            if item.get("priority") == "high":
                output.append(f"URGENT: {item['name']}")
            elif item.get("priority") == "medium":
                output.append(f"normal: {item['name']}")
            else:
                output.append(f"low: {item['name']}")
        elif item.get("type") == "B":
            for sub in item.get("children", []):
                if sub.get("active"):
                    output.append(f"active: {sub['name']}")
        else:
            output.append(f"unknown: {item}")
    return output

class DataProcessor:
    def __init__(self, config):
        self.config = config
        self.results = []

    def run(self, datasets):
        for ds in datasets:
            try:
                for record in ds.get("records", []):
                    if record.get("valid"):
                        self.results.append(self._transform(record))
                    else:
                        if self.config.get("strict"):
                            raise ValueError(f"Invalid record: {record}")
                        else:
                            continue
            except Exception as e:
                print(f"Error processing {ds['name']}: {e}")

    def _transform(self, record):
        return {k: v.strip() if isinstance(v, str) else v for k, v in record.items()}`,
  },

  // Rich sample with logging, multiple sequential functions, diverse constructs
  pythonRich: {
    filename: 'pipeline.py',
    language: 'python',
    content: `import logging
import json
from pathlib import Path

logger = logging.getLogger(__name__)

def load_config(path):
    """Load configuration from JSON file."""
    logger.info(f"Loading config from {path}")
    with open(path) as f:
        data = json.load(f)
    logger.debug(f"Config loaded: {len(data)} keys")
    return data

def validate_config(config):
    """Validate configuration keys."""
    required = ["input_dir", "output_dir", "batch_size"]
    missing = [k for k in required if k not in config]
    if missing:
        logger.error(f"Missing required keys: {missing}")
        raise ValueError(f"Missing keys: {missing}")
    if config["batch_size"] <= 0:
        logger.warning("batch_size must be positive, defaulting to 10")
        config["batch_size"] = 10
    logger.info("Config validation passed")
    return config

def read_input_files(input_dir):
    """Read all JSON files from input directory."""
    files = []
    logger.info(f"Scanning {input_dir} for JSON files")
    for p in sorted(Path(input_dir).glob("*.json")):
        try:
            with open(p) as f:
                data = json.load(f)
            logger.debug(f"Loaded {p.name}: {len(data)} records")
            files.append({"name": p.name, "records": data})
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse {p.name}: {e}")
        except PermissionError:
            logger.warning(f"Permission denied: {p.name}")
    logger.info(f"Loaded {len(files)} files")
    return files

def transform_record(record, rules):
    """Apply transformation rules to a single record."""
    result = dict(record)
    for rule in rules:
        field = rule.get("field")
        action = rule.get("action")
        if field not in result:
            continue
        if action == "uppercase":
            result[field] = str(result[field]).upper()
        elif action == "strip":
            result[field] = str(result[field]).strip()
        elif action == "default":
            if not result[field]:
                result[field] = rule.get("value", "")
        elif action == "delete":
            del result[field]
    return result

def process_batch(records, rules, batch_size):
    """Process records in batches with transformation rules."""
    results = []
    errors = []
    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        logger.info(f"Processing batch {i // batch_size + 1} ({len(batch)} records)")
        for record in batch:
            try:
                transformed = transform_record(record, rules)
                if transformed.get("valid", True):
                    results.append(transformed)
                else:
                    logger.warning(f"Skipping invalid record: {record.get('id', '?')}")
            except Exception as e:
                logger.error(f"Transform failed for {record.get('id', '?')}: {e}")
                errors.append({"record": record, "error": str(e)})
    logger.info(f"Batch processing complete: {len(results)} ok, {len(errors)} errors")
    return results, errors

def write_output(results, output_dir):
    """Write results to output directory."""
    output_path = Path(output_dir) / "output.json"
    logger.info(f"Writing {len(results)} results to {output_path}")
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    logger.info("Output written successfully")

def run_pipeline(config_path):
    """Main pipeline orchestrator."""
    logger.info("Starting pipeline")
    config = load_config(config_path)
    config = validate_config(config)
    files = read_input_files(config["input_dir"])
    all_records = []
    for f in files:
        all_records.extend(f["records"])
    logger.info(f"Total records: {len(all_records)}")
    rules = config.get("rules", [])
    results, errors = process_batch(all_records, rules, config["batch_size"])
    if errors:
        logger.warning(f"{len(errors)} errors during processing")
        for err in errors:
            logger.debug(f"  Error: {err}")
    write_output(results, config["output_dir"])
    logger.info("Pipeline complete")
    return results

if __name__ == "__main__":
    import sys
    if len(sys.argv) != 2:
        print("Usage: pipeline.py <config.json>")
        sys.exit(1)
    run_pipeline(sys.argv[1])`,
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

// The selection model only runs when the transcript contains selection keywords
// (select/highlight/mark/grab/lines). All tests below use selection utterances.
const selectionTests = [
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
  {
    name: 'select-lines-command',
    utterance: 'select lines 10 to 20',
    cursorLine: 15,
    file: SAMPLE_FILES.pythonClass,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      return {
        pass: +m[1] === 10 && +m[2] === 20,
        detail: `select ${m[1]} ${m[2]} (expected select 10 20)`,
      };
    },
  },
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
    utterance: 'select this function',
    cursorLine: 26, // inside processActivityFile body
    file: SAMPLE_FILES.jsModule,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // processActivityFile spans lines 22-30. Must include cursor line and function header.
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
    utterance: 'select the whole if elif else chain',
    cursorLine: 18, // inside elif branch
    file: SAMPLE_FILES.pythonIfElse,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // if/elif/else chain spans lines 11-38. Must start at first if.
      return {
        pass: +start <= 11 && +end >= 36,
        detail: `select ${start} ${end} (expected select covering if/elif/else ~11-38)`,
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
  // --- Nested construct precision tests (pythonNested sample) ---
  {
    name: 'nested-inner-for-loop',
    utterance: 'select the inner for loop',
    cursorLine: 8, // inside inner loop body (row_sum += val)
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Inner loop: for j, val in enumerate(row) spans lines 6-10
      // Must NOT include outer loop header (line 4)
      return {
        pass: +start >= 5 && +start <= 6 && +end >= 10 && +end <= 11 && +start > 4,
        detail: `select ${start} ${end} (expected inner loop only ~6-10, NOT outer)`,
      };
    },
  },
  {
    name: 'nested-outer-for-loop',
    utterance: 'select the outer for loop',
    cursorLine: 8, // inside inner loop body
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Outer loop: for i, row spans lines 4-11
      return {
        pass: +start <= 4 && +end >= 11,
        detail: `select ${start} ${end} (expected outer loop ~4-11)`,
      };
    },
  },
  {
    name: 'nested-inner-for-in-pairs',
    utterance: 'select the inner for loop',
    cursorLine: 20, // inside inner loop body (pairs.append line)
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Inner loop: for j in range(i+1,...) spans lines 18-20
      // Must NOT include outer loop header (line 17)
      return {
        pass: +start >= 17 && +start <= 18 && +end >= 20 && +end <= 21 && +start > 16,
        detail: `select ${start} ${end} (expected inner loop only ~18-20, NOT outer)`,
      };
    },
  },
  {
    name: 'nested-inner-if-in-conditionals',
    utterance: 'select the inner if statement',
    cursorLine: 29, // inside priority if/elif/else (line 29 = URGENT append)
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Inner if: priority check spans lines 28-33
      // Must NOT include outer if (type check at line 27)
      return {
        pass: +start >= 27 && +start <= 28 && +end >= 33 && +end <= 34 && +start > 26,
        detail: `select ${start} ${end} (expected inner if/elif/else ~28-33, NOT outer)`,
      };
    },
  },
  {
    name: 'nested-outer-if-in-conditionals',
    utterance: 'select the outer if statement',
    cursorLine: 29, // inside priority if/elif/else
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Outer if: type check spans lines 27-39
      return {
        pass: +start <= 27 && +end >= 39,
        detail: `select ${start} ${end} (expected outer if/elif/else ~27-39)`,
      };
    },
  },
  {
    name: 'nested-for-inside-elif',
    utterance: 'select the for loop inside the elif',
    cursorLine: 36, // inside the for sub loop (line 36 = if sub.get("active"))
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // for sub loop spans lines 35-37
      return {
        pass: +start <= 35 && +end >= 37 && +start >= 34,
        detail: `select ${start} ${end} (expected for sub loop ~35-37)`,
      };
    },
  },
  {
    name: 'nested-try-inside-method',
    utterance: 'select the try block',
    cursorLine: 52, // inside try body (self.results.append line)
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // try/except spans lines 49-59. Allow ±1 tolerance on end boundary.
      return {
        pass: +start <= 49 && +end >= 57,
        detail: `select ${start} ${end} (expected try/except ~49-59)`,
      };
    },
  },
  {
    name: 'nested-inner-for-in-try',
    utterance: 'select the inner for loop',
    cursorLine: 52, // inside for record loop within try
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Inner for: for record in ds.get("records") spans lines 50-57
      // Must NOT include outer for (line 48) or try (line 49)
      return {
        pass: +start >= 49 && +start <= 50 && +end >= 56 && +end <= 58,
        detail: `select ${start} ${end} (expected inner for record loop ~50-57)`,
      };
    },
  },
  {
    name: 'select-this-function-nested',
    utterance: 'select this function',
    cursorLine: 29, // deep inside nested_conditionals
    file: SAMPLE_FILES.pythonNested,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // nested_conditionals spans lines 23-40. Must include def header (23).
      return {
        pass: +start <= 23 && +end >= 40,
        detail: `select ${start} ${end} (expected nested_conditionals ~23-40)`,
      };
    },
  },

  // === Complex / advanced selection tests (pythonRich + pythonIfElse) ===

  // -- Ordinal selection: "the fourth elif" --
  {
    name: 'fourth-elif',
    utterance: 'select the fourth elif statement',
    cursorLine: 30, // inside the if/elif chain
    file: SAMPLE_FILES.pythonIfElse,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // 4th elif is "elif temp < 35:" (27-30). Accept ±1 branch tolerance (23-34).
      // Model may count initial if as a branch, shifting by one.
      return {
        pass: +start >= 23 && +start <= 31 && +end >= 26 && +end <= 34 && (+end - +start) >= 2,
        detail: `select ${start} ${end} (expected ~4th elif branch, ±1 tolerance)`,
      };
    },
  },
  {
    name: 'second-elif',
    utterance: 'select the second elif',
    cursorLine: 20,
    file: SAMPLE_FILES.pythonIfElse,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // 2nd elif is "elif temp < 15:" at lines 19-22
      return {
        pass: +start >= 19 && +start <= 20 && +end >= 21 && +end <= 22,
        detail: `select ${start} ${end} (expected 2nd elif ~19-22)`,
      };
    },
  },
  {
    name: 'else-block',
    utterance: 'select the else block',
    cursorLine: 30, // inside the chain
    file: SAMPLE_FILES.pythonIfElse,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // else block at lines 35-38
      return {
        pass: +start >= 35 && +start <= 36 && +end >= 37 && +end <= 38,
        detail: `select ${start} ${end} (expected else block ~35-38)`,
      };
    },
  },

  // -- Multi-function selection: "this function and the next two" --
  {
    name: 'this-and-next-two-functions',
    utterance: 'select this function and the next two as well',
    cursorLine: 10, // inside load_config (lines 7-13)
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // load_config (7-13), validate_config (15-26), read_input_files (28-43)
      return {
        pass: +start <= 7 && +end >= 43,
        detail: `select ${start} ${end} (expected 3 functions ~7-43)`,
      };
    },
  },
  {
    name: 'next-three-lines',
    utterance: 'select the next three lines',
    cursorLine: 70, // logger.info line in process_batch
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Next 3 lines after cursor 70 = lines 71-73
      return {
        pass: +start === 71 && +end === 73,
        detail: `select ${start} ${end} (expected 71 73)`,
      };
    },
  },

  // -- Content-based selection: "the logs in this function" --
  {
    name: 'logs-in-function',
    utterance: 'select the log statements in this function',
    cursorLine: 10, // inside load_config
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // load_config has logger calls at lines 9 and 12.
      // Should cover at least both log lines.
      return {
        pass: +start <= 9 && +end >= 12,
        detail: `select ${start} ${end} (expected log lines ~9-12)`,
      };
    },
  },

  // -- Try/except selection --
  {
    name: 'select-try-except-in-for',
    utterance: 'select this try except block',
    cursorLine: 39, // inside the except JSONDecodeError of read_input_files
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // try/except in read_input_files spans lines 33-41.
      // The cursor at 39 (inside except block) is unambiguously in this try/except.
      return {
        pass: +start <= 33 && +end >= 41,
        detail: `select ${start} ${end} (expected try/except ~33-41)`,
      };
    },
  },

  // -- Select by description --
  {
    name: 'select-batch-processing-function',
    utterance: 'select the function that processes batches',
    cursorLine: 70,
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // process_batch spans lines 64-82
      return {
        pass: +start <= 64 && +end >= 82,
        detail: `select ${start} ${end} (expected process_batch ~64-82)`,
      };
    },
  },

  // -- Second elif in transform_record --
  {
    name: 'second-elif-in-transform',
    utterance: 'select the second elif in this function',
    cursorLine: 54, // inside transform_record
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Elifs: 1st="strip"(55-56), 2nd="default"(57-59), 3rd="delete"(60-61)
      return {
        pass: +start >= 57 && +start <= 58 && +end >= 58 && +end <= 59,
        detail: `select ${start} ${end} (expected 2nd elif "default" ~57-59)`,
      };
    },
  },

  // -- Select from here to end of function --
  {
    name: 'select-to-end-of-function',
    utterance: 'select from here to the end of the function',
    cursorLine: 97, // inside run_pipeline, after first few lines
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // From cursor line 97 to end of run_pipeline (line 110)
      return {
        pass: +start >= 97 && +start <= 98 && +end >= 110,
        detail: `select ${start} ${end} (expected ~97-110)`,
      };
    },
  },

  // -- Select the imports --
  {
    name: 'select-imports',
    utterance: 'select the imports',
    cursorLine: 2,
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // imports are lines 1-3
      return {
        pass: +start <= 1 && +end >= 3 && +end <= 5,
        detail: `select ${start} ${end} (expected imports ~1-3)`,
      };
    },
  },

  // -- Select the inner for loop in process_batch --
  {
    name: 'inner-for-in-process-batch',
    utterance: 'select the inner for loop',
    cursorLine: 73, // inside the inner for record loop
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // Inner for: "for record in batch:" spans lines 71-80
      // Must NOT include outer for (line 68). Allow some tolerance on start.
      return {
        pass: +start >= 70 && +start <= 73 && +end >= 79 && +end <= 81 && +start > 68,
        detail: `select ${start} ${end} (expected inner for ~71-80, NOT outer)`,
      };
    },
  },

  // -- Select just this line --
  {
    name: 'select-just-this-line',
    utterance: 'select just this line',
    cursorLine: 25,
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      return {
        pass: +start === 25 && +end === 25,
        detail: `select ${start} ${end} (expected 25 25)`,
      };
    },
  },

  // -- Select the error handling in read_input_files --
  {
    name: 'select-except-blocks',
    utterance: 'select the except blocks in this function',
    cursorLine: 36, // inside read_input_files
    file: SAMPLE_FILES.pythonRich,
    validate: (raw) => {
      const m = raw.trim().toLowerCase().match(/^select\s+(\d+)\s+(\d+)/);
      if (!m) return { pass: false, detail: `Expected select, got: ${raw.slice(0, 60)}` };
      const [, start, end] = m;
      // except blocks at lines 38-41 (JSONDecodeError + PermissionError)
      return {
        pass: +start >= 38 && +start <= 39 && +end >= 40 && +end <= 42,
        detail: `select ${start} ${end} (expected except blocks ~38-41)`,
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
