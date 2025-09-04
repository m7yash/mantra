import * as vscode from 'vscode';

export type CommandSpec = {
  id: string;
  name: string;
  aliases?: string[];
  category?: 'file' | 'edit' | 'view' | 'navigate' | 'search' | 'terminal' | 'debug';
  description?: string;
};

export function normalizeUtterance(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/^\s*command\s+/, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(s: string): string {
  return normalizeUtterance(s);
}

const SPECS: CommandSpec[] = [
  // File
  { id: 'workbench.action.files.save', name: 'save', aliases: ['save file', 'save document'], category: 'file' },
  { id: 'workbench.action.files.saveAll', name: 'save all', aliases: ['save all files'], category: 'file' },
  { id: 'workbench.action.files.newUntitledFile', name: 'new file', aliases: ['create file', 'new tab'], category: 'file' },
  { id: 'workbench.action.closeActiveEditor', name: 'close file', aliases: ['close editor', 'close tab'], category: 'file' },
  { id: 'workbench.action.reopenClosedEditor', name: 'reopen closed editor', aliases: ['reopen closed tab', 'undo close tab'], category: 'file' },

  // Edit (simple)
  { id: 'undo', name: 'undo', category: 'edit' },
  { id: 'redo', name: 'redo', category: 'edit' },
  { id: 'editor.action.clipboardCutAction', name: 'cut', aliases: ['cut selection'], category: 'edit' },
  { id: 'editor.action.clipboardCopyAction', name: 'copy', aliases: ['copy selection'], category: 'edit' },

  { id: 'editor.action.selectAll', name: 'select all', category: 'edit' },
  { id: 'editor.action.commentLine', name: 'toggle line comment', aliases: ['line comment', 'toggle comment'], category: 'edit' },
  { id: 'editor.action.blockComment', name: 'toggle block comment', aliases: ['block comment'], category: 'edit' },
  { id: 'editor.action.formatDocument', name: 'format document', aliases: ['format file', 'style file', 'format code'], category: 'edit' },
  { id: 'editor.action.formatSelection', name: 'format selection', category: 'edit' },
  { id: 'editor.action.rename', name: 'rename symbol', aliases: ['rename'], category: 'edit' },
  { id: 'editor.action.quickFix', name: 'quick fix', aliases: ['fix', 'show quick fix'], category: 'edit' },
  { id: 'editor.action.organizeImports', name: 'organize imports', category: 'edit' },

  // Selection / multi-cursor
  { id: 'editor.action.smartSelect.grow', name: 'expand selection', category: 'edit' },
  { id: 'editor.action.smartSelect.shrink', name: 'shrink selection', category: 'edit' },
  { id: 'editor.action.addSelectionToNextFindMatch', name: 'select next occurrence', aliases: ['add next occurrence'], category: 'edit' },

  // Line ops / movement
  { id: 'editor.action.copyLinesDownAction', name: 'duplicate line down', aliases: ['duplicate line', 'duplicate lines down'], category: 'edit' },
  { id: 'editor.action.copyLinesUpAction', name: 'duplicate line up', aliases: ['duplicate lines up'], category: 'edit' },
  { id: 'editor.action.moveLinesUpAction', name: 'move line up', aliases: ['move lines up'], category: 'edit' },
  { id: 'editor.action.moveLinesDownAction', name: 'move line down', aliases: ['move lines down'], category: 'edit' },
  { id: 'editor.action.insertCursorAbove', name: 'add cursor above', category: 'edit' },
  { id: 'editor.action.insertCursorBelow', name: 'add cursor below', category: 'edit' },

  // Folding / wrapping
  { id: 'editor.foldAll', name: 'fold all', category: 'view' },
  { id: 'editor.unfoldAll', name: 'unfold all', category: 'view' },
  { id: 'editor.action.toggleWordWrap', name: 'toggle word wrap', aliases: ['word wrap'], category: 'view' },

  // Find/Replace
  { id: 'actions.find', name: 'find', aliases: ['find in editor'], category: 'search' },
  { id: 'editor.action.startFindReplaceAction', name: 'replace', aliases: ['find and replace'], category: 'search' },
  { id: 'workbench.action.findInFiles', name: 'find in files', category: 'search' },
  { id: 'workbench.action.replaceInFiles', name: 'replace in files', category: 'search' },

  // Navigation / tabs
  { id: 'workbench.action.navigateBack', name: 'back', aliases: ['go back', 'navigate back'], category: 'navigate' },
  { id: 'workbench.action.navigateForward', name: 'forward', aliases: ['go forward', 'navigate forward'], category: 'navigate' },
  { id: 'workbench.action.nextEditor', name: 'next tab', aliases: ['next editor', 'switch to next tab'], category: 'navigate' },
  { id: 'workbench.action.previousEditor', name: 'previous tab', aliases: ['prev tab', 'previous editor', 'switch to previous tab'], category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex1', name: 'tab one', aliases: ['first tab'], category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex2', name: 'tab two', aliases: ['second tab'], category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex3', name: 'tab three', category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex4', name: 'tab four', category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex5', name: 'tab five', category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex6', name: 'tab six', category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex7', name: 'tab seven', category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex8', name: 'tab eight', category: 'navigate' },
  { id: 'workbench.action.openEditorAtIndex9', name: 'tab nine', category: 'navigate' },

    // Scrolling (simple)
  { id: 'cursorPageUp', name: 'page up', aliases: ['scroll up one page'], category: 'navigate' },
  { id: 'cursorPageDown', name: 'page down', aliases: ['scroll down one page'], category: 'navigate' },

  // Go to / Peek
  { id: 'editor.action.revealDefinition', name: 'go to definition', aliases: ['goto definition'], category: 'navigate' },
  { id: 'editor.action.peekDefinition', name: 'peek definition', category: 'navigate' },
  { id: 'editor.action.referenceSearch.trigger', name: 'go to references', aliases: ['show references'], category: 'navigate' },
  { id: 'editor.action.goToImplementation', name: 'go to implementation', category: 'navigate' },
  { id: 'editor.action.jumpToBracket', name: 'jump to bracket', category: 'navigate' },

  // View / window
  { id: 'workbench.action.toggleSidebarVisibility', name: 'toggle sidebar', aliases: ['sidebar'], category: 'view' },
  { id: 'workbench.action.togglePanel', name: 'toggle panel', aliases: ['panel'], category: 'view' },
  { id: 'workbench.action.toggleZenMode', name: 'toggle zen mode', aliases: ['zen mode', 'toggle zen'], category: 'view' },
  { id: 'workbench.action.splitEditorRight', name: 'split editor', category: 'view' },
  { id: 'editor.action.toggleMinimap', name: 'toggle minimap', aliases: ['minimap'], category: 'view' },
  { id: 'workbench.action.zoomIn', name: 'zoom in', category: 'view' },
  { id: 'workbench.action.zoomOut', name: 'zoom out', category: 'view' },
  { id: 'workbench.action.zoomReset', name: 'reset zoom', aliases: ['zoom reset'], category: 'view' },

  // Terminal
  { id: 'workbench.action.terminal.toggleTerminal', name: 'toggle terminal', aliases: ['terminal'], category: 'terminal' },
  { id: 'workbench.action.terminal.focus', name: 'focus terminal', category: 'terminal' },
  { id: 'workbench.action.terminal.new', name: 'new terminal', category: 'terminal' },

  // Explorer / palette
  { id: 'workbench.view.explorer', name: 'focus explorer', aliases: ['show explorer', 'open explorer'], category: 'view' },
  { id: 'workbench.view.search', name: 'focus search', aliases: ['show search'], category: 'view' },
  { id: 'workbench.view.scm', name: 'focus source control', aliases: ['show source control', 'show git'], category: 'view' },
  { id: 'workbench.view.debug', name: 'focus debug', aliases: ['show debug'], category: 'view' },
  { id: 'workbench.view.extensions', name: 'focus extensions', aliases: ['show extensions'], category: 'view' },
  { id: 'workbench.action.showCommands', name: 'show command palette', aliases: ['command palette', 'show commands'], category: 'view' },
  { id: 'workbench.action.quickOpen', name: 'quick open', aliases: ['open file', 'open by name'], category: 'view' },

  // Debugging
  { id: 'editor.debug.action.toggleBreakpoint', name: 'toggle breakpoint', aliases: ['add breakpoint', 'remove breakpoint'], category: 'debug' },
  { id: 'workbench.action.debug.start', name: 'start debugging', category: 'debug' },
  { id: 'workbench.action.debug.stop', name: 'stop debugging', category: 'debug' },
  { id: 'workbench.action.debug.continue', name: 'continue debugging', aliases: ['continue'], category: 'debug' },
  { id: 'workbench.action.debug.stepOver', name: 'step over', category: 'debug' },
  { id: 'workbench.action.debug.stepInto', name: 'step into', category: 'debug' },
  { id: 'workbench.action.debug.stepOut', name: 'step out', category: 'debug' },
];

const ALIAS_TO_ID = new Map<string, string>();
const ID_TO_ALIASES = new Map<string, string[]>();

for (const spec of SPECS) {
  const all = [spec.name, ...(spec.aliases || [])];
  const normed = all.map(norm);
  ID_TO_ALIASES.set(spec.id, normed);
  for (const a of normed) {
    if (!ALIAS_TO_ID.has(a)) ALIAS_TO_ID.set(a, spec.id);
  }
}

export const COMMAND_ALIASES: ReadonlyMap<string, readonly string[]> = ID_TO_ALIASES;

export function canonicalCommandPhrases(): string[] {
  const out: string[] = [];
  for (const spec of SPECS) {
    out.push(spec.name);
    if (spec.aliases && spec.aliases.length) out.push(spec.aliases[0]);
  }
  return Array.from(new Set(out)).sort();
}

export async function tryExecuteMappedCommand(utterance: string): Promise<boolean> {
  const u = norm(utterance);
  if (!u) return false;

  const candidates = [u, u.replace(/^toggle\s+/, ''), u.replace(/\s+(please|now)$/i, '')];

  for (const c of candidates) {
    const id = ALIAS_TO_ID.get(c);
    if (id) {
      try {
        await vscode.commands.executeCommand(id);
        vscode.window.setStatusBarMessage(`Executed: ${c}`, 1200);
        return true;
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to execute ${id}: ${(err as Error).message}`);
        return false;
      }
    }
  }
  return false;
}

export default SPECS;