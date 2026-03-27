import * as vscode from 'vscode';
import { exec } from 'child_process';

// ─── AppleScript helpers ─────────────────────────────────────────────────────

function runAppleScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
      if (err) {
        console.warn('[Mantra] AppleScript failed:', err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function keystroke(key: string, modifiers?: string[]): Promise<void> {
  const usingClause = modifiers?.length
    ? ` using {${modifiers.map(m => `${m} down`).join(', ')}}`
    : '';
  return runAppleScript(`tell application "System Events" to keystroke "${key}"${usingClause}`);
}

function keyCode(code: number, modifiers?: string[]): Promise<void> {
  const usingClause = modifiers?.length
    ? ` using {${modifiers.map(m => `${m} down`).join(', ')}}`
    : '';
  return runAppleScript(`tell application "System Events" to key code ${code}${usingClause}`);
}

// ─── Mouse control via JXA (JavaScript for Automation via osascript) ─────────
// Uses the ObjC bridge built into osascript — no Python/Quartz dependency.

function runJxa(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
      if (err) {
        console.warn('[Mantra] JXA mouse failed:', err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function moveMouse(dx: number, dy: number): Promise<void> {
  return runJxa(
    `ObjC.import("Cocoa"); var loc=$.NSEvent.mouseLocation; var h=$.NSScreen.mainScreen.frame.size.height; var x=loc.x+${dx}; var y=h-loc.y+${dy}; var e=$.CGEventCreateMouseEvent($(),6,{x:x,y:y},0); $.CGEventPost(0,e);`
  );
}

function mouseClick(button: 'left' | 'right' | 'double'): Promise<void> {
  if (button === 'left') {
    return runJxa(
      `ObjC.import("Cocoa"); var loc=$.NSEvent.mouseLocation; var h=$.NSScreen.mainScreen.frame.size.height; var p={x:loc.x,y:h-loc.y}; var d=$.CGEventCreateMouseEvent($(),1,p,0); $.CGEventPost(0,d); var u=$.CGEventCreateMouseEvent($(),2,p,0); $.CGEventPost(0,u);`
    );
  } else if (button === 'right') {
    return runJxa(
      `ObjC.import("Cocoa"); var loc=$.NSEvent.mouseLocation; var h=$.NSScreen.mainScreen.frame.size.height; var p={x:loc.x,y:h-loc.y}; var d=$.CGEventCreateMouseEvent($(),3,p,1); $.CGEventPost(0,d); var u=$.CGEventCreateMouseEvent($(),4,p,1); $.CGEventPost(0,u);`
    );
  } else {
    return runJxa(
      `ObjC.import("Cocoa"); var loc=$.NSEvent.mouseLocation; var h=$.NSScreen.mainScreen.frame.size.height; var p={x:loc.x,y:h-loc.y}; var d1=$.CGEventCreateMouseEvent($(),1,p,0); $.CGEventSetIntegerValueField(d1,105,1); $.CGEventPost(0,d1); var u1=$.CGEventCreateMouseEvent($(),2,p,0); $.CGEventPost(0,u1); delay(0.05); var d2=$.CGEventCreateMouseEvent($(),1,p,0); $.CGEventSetIntegerValueField(d2,105,2); $.CGEventPost(0,d2); var u2=$.CGEventCreateMouseEvent($(),2,p,0); $.CGEventSetIntegerValueField(u2,105,2); $.CGEventPost(0,u2);`
    );
  }
}

// ─── Key code map ────────────────────────────────────────────────────────────

const KEY_CODES: Record<string, number> = {
  enter: 36, return: 36, escape: 53, tab: 48, space: 49,
  delete: 117, backspace: 51,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119,
  'page up': 116, 'page down': 121,
};

// ─── App name aliases ────────────────────────────────────────────────────────
// Maps commonly-spoken names to the macOS bundle name used by `open -a`.

const APP_ALIASES: Record<string, string> = {
  'vs code': 'Visual Studio Code',
  'vscode': 'Visual Studio Code',
  'versus code': 'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  'visual studio': 'Visual Studio Code',
  'ide': 'Visual Studio Code',
  'code': 'Visual Studio Code',
  'code editor': 'Visual Studio Code',
  'my editor': 'Visual Studio Code',
  'the editor': 'Visual Studio Code',
  'chrome': 'Google Chrome',
  'iterm': 'iTerm',
  'i term': 'iTerm',
  'postman': 'Postman',
};

// ─── Spoken number parsing ──────────────────────────────────────────────────

const SPOKEN_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

function parseSpokenNumber(s: string): number | null {
  const n = parseInt(s, 10);
  if (!isNaN(n)) return n;
  return SPOKEN_NUMBERS[s.toLowerCase()] ?? null;
}

function resolveAppName(spoken: string): string {
  return APP_ALIASES[spoken.toLowerCase()] || spoken;
}

// ─── Polite prefix stripping ─────────────────────────────────────────────────

function stripPolitePrefix(s: string): string {
  return s
    .replace(/^(?:could you (?:please )?|can you (?:please )?|would you (?:please )?|please (?:go ahead and )?|go ahead and |just |hey |yo )/i, '')
    .trim();
}

// ─── Exported helpers for use by extension.ts ────────────────────────────────

/** Send a keystroke via System Events (for use outside this module). */
export function sendSystemKeystroke(key: string, modifiers?: string[]): Promise<void> {
  return keystroke(key, modifiers);
}



// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * Try to handle a system-level command.
 * @param tc — punctuation-stripped transcript
 * @param vscFocused — true if VS Code window is currently focused
 * Returns true if handled. macOS only — returns false on other platforms.
 */
export async function trySystemCommand(tc: string, vscFocused: boolean): Promise<boolean> {
  if (process.platform !== 'darwin') return false;

  // Strip polite prefixes so "could you please open Safari" matches "open Safari"
  tc = stripPolitePrefix(tc);

  // ══════════════════════════════════════════════════════════════════════════
  // ALWAYS-ON commands (regardless of VS Code focus)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Keyboard shortcuts: "command B", "control shift P", etc. ──
  const kbMatch = tc.match(/^((?:(?:command|cmd|control|ctrl|alt|option|shift)[\s+]*)+)([a-z0-9/\\[\]'`,.\-=])$/i);
  if (kbMatch) {
    const modsRaw = kbMatch[1].toLowerCase();
    const key = kbMatch[2];
    const usings: string[] = [];
    if (/command|cmd/.test(modsRaw)) usings.push('command down');
    if (/control|ctrl/.test(modsRaw)) usings.push('control down');
    if (/alt|option/.test(modsRaw)) usings.push('option down');
    if (/shift/.test(modsRaw)) usings.push('shift down');
    const usingClause = usings.length > 0 ? ` using {${usings.join(', ')}}` : '';
    const script = `tell application "System Events" to keystroke "${key}"${usingClause}`;
    exec(`osascript -e '${script}'`, (err) => {
      if (err) console.warn('[Mantra] osascript keystroke failed:', err.message);
    });
    vscode.window.setStatusBarMessage(`⌨️ ${modsRaw.trim()} ${key}`, 1500);
    return true;
  }

  // ── "click" → real mouse click at current cursor position ──
  if (/^click$/i.test(tc)) {
    try { await mouseClick('left'); } catch {}
    vscode.window.setStatusBarMessage('Click', 1200);
    return true;
  }
  // double click
  if (/^double\s+click$/i.test(tc)) {
    try { await mouseClick('double'); } catch {}
    vscode.window.setStatusBarMessage('Double click', 1200);
    return true;
  }
  // right click
  if (/^right\s+click$/i.test(tc)) {
    try { await mouseClick('right'); } catch {}
    vscode.window.setStatusBarMessage('Right click', 1200);
    return true;
  }

  // ── Open apps: "open Safari", "open VS Code", "open IDE" ──
  const appMatch = tc.match(/^open\s+(.+)$/i);
  if (appMatch) {
    const raw = appMatch[1].replace(/[.,!?;:]+$/, '').trim();
    const appName = resolveAppName(raw);
    exec(`open -a "${appName}"`, (err) => {
      if (err) {
        // If alias resolution failed, try the raw name
        if (appName !== raw) {
          exec(`open -a "${raw}"`, (err2) => {
            if (err2) vscode.window.showWarningMessage(`Could not open "${raw}": ${err2.message}`);
          });
        } else {
          vscode.window.showWarningMessage(`Could not open "${appName}": ${err.message}`);
        }
      }
    });
    vscode.window.setStatusBarMessage(`Opening ${appName}...`, 2000);
    return true;
  }

  // ── Press <key>: "press enter", "press escape", etc. ──
  const pressMatch = tc.match(/^press\s+(enter|return|escape|tab|space|delete|backspace|up|down|left|right|home|end|page up|page down)$/i);
  if (pressMatch) {
    const keyName = pressMatch[1].toLowerCase();
    const code = KEY_CODES[keyName];
    if (code !== undefined) {
      await keyCode(code);
      vscode.window.setStatusBarMessage(`⌨️ ${keyName}`, 1200);
    }
    return true;
  }

  // ── Type/dictate text: "type hello world" ──
  const typeMatch = tc.match(/^(?:type|dictate)\s+(.+)$/i);
  if (typeMatch) {
    const text = typeMatch[1];
    await vscode.env.clipboard.writeText(text);
    await keystroke('v', ['command']);
    vscode.window.setStatusBarMessage(`Typed: ${text}`, 1500);
    return true;
  }

  // ── Browser / navigation ──

  // go back / back
  if (/^(go\s+)?back$/i.test(tc)) {
    await keystroke('[', ['command']);
    vscode.window.setStatusBarMessage('Back', 1200);
    return true;
  }
  // go forward / forward
  if (/^(go\s+)?forward$/i.test(tc)) {
    await keystroke(']', ['command']);
    vscode.window.setStatusBarMessage('Forward', 1200);
    return true;
  }
  // refresh / reload / hard refresh
  if (/^(hard\s+)?(?:refresh|reload)(\s+page)?$/i.test(tc)) {
    if (/^hard/i.test(tc)) {
      await keystroke('r', ['command', 'shift']);
    } else {
      await keystroke('r', ['command']);
    }
    vscode.window.setStatusBarMessage('Refresh', 1200);
    return true;
  }
  // new tab
  if (/^new\s+tab$/i.test(tc)) {
    await keystroke('t', ['command']);
    vscode.window.setStatusBarMessage('New tab', 1200);
    return true;
  }
  // close tab
  if (/^close\s+tab$/i.test(tc)) {
    await keystroke('w', ['command']);
    vscode.window.setStatusBarMessage('Closed tab', 1200);
    return true;
  }
  // reopen tab / reopen closed tab
  if (/^reopen\s+(closed\s+)?tab$/i.test(tc)) {
    await keystroke('t', ['command', 'shift']);
    vscode.window.setStatusBarMessage('Reopened tab', 1200);
    return true;
  }
  // address bar / url bar
  if (/^(address\s+bar|url\s+bar|focus\s+url|browser\s+address)$/i.test(tc)) {
    await keystroke('l', ['command']);
    vscode.window.setStatusBarMessage('Address bar', 1200);
    return true;
  }
  // bookmark page
  if (/^bookmark(\s+page|\s+this)?$/i.test(tc)) {
    await keystroke('d', ['command']);
    vscode.window.setStatusBarMessage('Bookmarked', 1200);
    return true;
  }

  // ── Window / app management ──

  // switch to <app>
  const switchMatch = tc.match(/^switch\s+to\s+(.+)$/i);
  if (switchMatch) {
    const raw = switchMatch[1].replace(/[.,!?;:]+$/, '').trim();
    const appName = resolveAppName(raw);
    try {
      await runAppleScript(`tell application "${appName}" to activate`);
      vscode.window.setStatusBarMessage(`Switched to ${appName}`, 1500);
    } catch {
      vscode.window.showWarningMessage(`Could not switch to "${appName}"`);
    }
    return true;
  }
  // minimize window
  if (/^minimize(\s+window)?$/i.test(tc)) {
    await keystroke('m', ['command']);
    vscode.window.setStatusBarMessage('Minimized', 1200);
    return true;
  }
  // close window
  if (/^close\s+window$/i.test(tc)) {
    await keystroke('w', ['command']);
    vscode.window.setStatusBarMessage('Closed window', 1200);
    return true;
  }
  // full screen
  if (/^(toggle\s+)?full\s*screen$/i.test(tc)) {
    await keystroke('f', ['command', 'control']);
    vscode.window.setStatusBarMessage('Full screen', 1200);
    return true;
  }
  // next window (same app)
  if (/^next\s+window$/i.test(tc)) {
    await keystroke('`', ['command']);
    vscode.window.setStatusBarMessage('Next window', 1200);
    return true;
  }
  // previous window
  if (/^prev(?:ious)?\s+window$/i.test(tc)) {
    await keystroke('`', ['command', 'shift']);
    vscode.window.setStatusBarMessage('Previous window', 1200);
    return true;
  }
  // hide app
  if (/^hide(\s+app|\s+this)?$/i.test(tc)) {
    await keystroke('h', ['command']);
    vscode.window.setStatusBarMessage('Hidden', 1200);
    return true;
  }
  // show desktop
  if (/^show\s+desktop$/i.test(tc)) {
    await keyCode(160); // F11
    vscode.window.setStatusBarMessage('Show desktop', 1200);
    return true;
  }
  // mission control
  if (/^mission\s+control$/i.test(tc)) {
    await keyCode(126, ['control']); // Ctrl+Up
    vscode.window.setStatusBarMessage('Mission Control', 1200);
    return true;
  }

  // ── System utilities ──

  // spotlight / search
  if (/^(spotlight|search\s+(?:computer|mac|system)|open\s+spotlight)$/i.test(tc)) {
    await keyCode(49, ['command']); // Cmd+Space
    vscode.window.setStatusBarMessage('Spotlight', 1200);
    return true;
  }
  // screenshot (full screen)
  if (/^(take\s+)?screenshot$/i.test(tc)) {
    await keystroke('3', ['command', 'shift']);
    vscode.window.setStatusBarMessage('Screenshot', 1200);
    return true;
  }
  // screenshot selection
  if (/^screenshot\s+(selection|area|region|part)$/i.test(tc)) {
    await keystroke('4', ['command', 'shift']);
    vscode.window.setStatusBarMessage('Screenshot selection', 1200);
    return true;
  }
  // lock screen
  if (/^lock\s+screen$/i.test(tc)) {
    await keystroke('q', ['command', 'control']);
    vscode.window.setStatusBarMessage('Locked', 1200);
    return true;
  }

  // ── Mouse control ──

  // move mouse <direction> [N pixels]
  const mouseMove = tc.match(/^move\s+(?:mouse|cursor)\s+(up|down|left|right)(?:\s+(\d+)(?:\s+pixels?)?)?$/i);
  if (mouseMove) {
    const dir = mouseMove[1].toLowerCase();
    const amount = parseInt(mouseMove[2] || '50', 10);
    const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
    const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
    try {
      await moveMouse(dx, dy);
      vscode.window.setStatusBarMessage(`Mouse ${dir} ${amount}px`, 1200);
    } catch {
      vscode.window.showWarningMessage('Mouse control requires Python3 with Quartz (built into macOS)');
    }
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UNFOCUSED-ONLY commands — when VS Code is NOT the active window,
  // route common actions as System Events keystrokes to the frontmost app.
  // When VS Code IS focused, these fall through to the VS Code pipeline.
  // ══════════════════════════════════════════════════════════════════════════

  if (!vscFocused) {
    // ── Arrow keys: "up", "down", "left", "right" ──
    if (/^(up|go up|arrow up|up arrow)$/i.test(tc)) { await keyCode(126); return true; }
    if (/^(down|go down|arrow down|down arrow)$/i.test(tc)) { await keyCode(125); return true; }
    if (/^(left|go left|arrow left|left arrow)$/i.test(tc)) { await keyCode(123); return true; }
    if (/^(right|go right|arrow right|right arrow)$/i.test(tc)) { await keyCode(124); return true; }

    // ── Repeated keys: "up 5 times", "down three times", "left 2 times" ──
    {
      const repeatMatch = tc.match(/^(up|down|left|right)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+times?$/i);
      if (repeatMatch) {
        const dir = repeatMatch[1].toLowerCase();
        const n = parseSpokenNumber(repeatMatch[2]);
        if (n && n > 0) {
          const code = dir === 'up' ? 126 : dir === 'down' ? 125 : dir === 'left' ? 123 : 124;
          const count = Math.min(n, 50); // safety cap
          for (let i = 0; i < count; i++) await keyCode(code);
          vscode.window.setStatusBarMessage(`${dir} ${count}x`, 1200);
          return true;
        }
      }
    }

    // ── Scrolling: multiple arrow presses for smooth scrolling ──
    if (/^scroll\s+up$/i.test(tc)) {
      for (let i = 0; i < 15; i++) await keyCode(126);
      vscode.window.setStatusBarMessage('Scroll up', 1200);
      return true;
    }
    if (/^scroll\s+down$/i.test(tc)) {
      for (let i = 0; i < 15; i++) await keyCode(125);
      vscode.window.setStatusBarMessage('Scroll down', 1200);
      return true;
    }
    // "scroll up/down a lot" or "scroll up/down more" → multiple page up/downs
    if (/^scroll\s+up\s+(a\s+lot|more|way up|far)$/i.test(tc)) {
      for (let i = 0; i < 2; i++) await keyCode(116);
      vscode.window.setStatusBarMessage('Scroll up a lot', 1200);
      return true;
    }
    if (/^scroll\s+down\s+(a\s+lot|more|way down|far)$/i.test(tc)) {
      for (let i = 0; i < 2; i++) await keyCode(121);
      vscode.window.setStatusBarMessage('Scroll down a lot', 1200);
      return true;
    }
    // page up / page down
    if (/^page\s+up$/i.test(tc)) { await keyCode(116); return true; }
    if (/^page\s+down$/i.test(tc)) { await keyCode(121); return true; }
    // scroll to top / bottom
    if (/^scroll\s+to\s+(?:the\s+)?top$/i.test(tc)) { await keyCode(115, ['command']); return true; }
    if (/^scroll\s+to\s+(?:the\s+)?bottom$/i.test(tc)) { await keyCode(119, ['command']); return true; }

    // ── Basic keys ──
    if (/^(enter|return|submit)$/i.test(tc)) { await keyCode(36); return true; }
    if (/^(escape|cancel|dismiss|nevermind|never mind)$/i.test(tc)) { await keyCode(53); return true; }
    if (/^tab$/i.test(tc)) { await keyCode(48); return true; }
    if (/^space$/i.test(tc)) { await keyCode(49); return true; }
    if (/^(delete|backspace)$/i.test(tc)) { await keyCode(51); return true; }

    // ── Text editing (Cmd shortcuts → frontmost app) ──
    if (/^(undo)$/i.test(tc)) { await keystroke('z', ['command']); return true; }
    if (/^(redo)$/i.test(tc)) { await keystroke('z', ['command', 'shift']); return true; }
    if (/^(copy|copy that|copy selection)$/i.test(tc)) { await keystroke('c', ['command']); return true; }
    if (/^(paste|paste that|paste it)$/i.test(tc)) { await keystroke('v', ['command']); return true; }
    if (/^(cut|cut selection|cut that)$/i.test(tc)) { await keystroke('x', ['command']); return true; }
    if (/^(select all)$/i.test(tc)) { await keystroke('a', ['command']); return true; }
    if (/^(find|search)$/i.test(tc)) { await keystroke('f', ['command']); return true; }
    if (/^(save)$/i.test(tc)) { await keystroke('s', ['command']); return true; }
    if (/^(close|close this)$/i.test(tc)) { await keystroke('w', ['command']); return true; }
    if (/^(quit|quit app)$/i.test(tc)) { await keystroke('q', ['command']); return true; }
    if (/^(zoom in)$/i.test(tc)) { await keystroke('=', ['command']); return true; }
    if (/^(zoom out)$/i.test(tc)) { await keystroke('-', ['command']); return true; }
    if (/^(reset zoom|actual size)$/i.test(tc)) { await keystroke('0', ['command']); return true; }

    // ── Selection ──
    if (/^select\s+to\s+(?:end|right)$/i.test(tc)) { await keyCode(124, ['command', 'shift']); return true; }
    if (/^select\s+to\s+(?:start|beginning|left)$/i.test(tc)) { await keyCode(123, ['command', 'shift']); return true; }
    if (/^select\s+word$/i.test(tc)) { await keyCode(124, ['option', 'shift']); return true; }
    if (/^select\s+line$/i.test(tc)) {
      await keyCode(123, ['command']); // Home
      await keyCode(124, ['command', 'shift']); // Shift+End
      return true;
    }

    // ── Tab switching ──
    // next tab / previous tab
    if (/^next\s+tab$/i.test(tc)) { await keyCode(48, ['control']); return true; } // Ctrl+Tab
    if (/^prev(?:ious)?\s+tab$/i.test(tc)) { await keyCode(48, ['control', 'shift']); return true; }
    // last tab
    if (/^last\s+tab$/i.test(tc)) { await keystroke('9', ['command']); return true; }

    // Numbered tab: "first tab", "tab 1", "3rd tab", "tab three", etc.
    {
      const tabMatch = tc.match(/^(?:(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|\d+)(?:st|nd|rd|th)?\s+tab|tab\s+(\d+|one|two|three|four|five|six|seven|eight|nine))$/i);
      if (tabMatch) {
        const raw = (tabMatch[1] || tabMatch[2]).toLowerCase();
        const ORDINALS: Record<string, number> = {
          first: 1, one: 1, second: 2, two: 2, third: 3, three: 3,
          fourth: 4, four: 4, fifth: 5, five: 5, sixth: 6, six: 6,
          seventh: 7, seven: 7, eighth: 8, eight: 8, ninth: 9, nine: 9,
        };
        const n = ORDINALS[raw] || parseInt(raw, 10);
        if (n >= 1 && n <= 9) {
          await keystroke(String(n), ['command']); // Cmd+N for tab N
          vscode.window.setStatusBarMessage(`Tab ${n}`, 1200);
          return true;
        }
      }
    }

    // ── Developer tools (browser) ──
    if (/^(dev\s*tools|developer\s+tools|inspect\s+element|inspect|open\s+dev\s*tools)$/i.test(tc)) {
      await keystroke('i', ['command', 'option']);
      vscode.window.setStatusBarMessage('DevTools', 1200);
      return true;
    }
    if (/^(console|open\s+console|javascript\s+console)$/i.test(tc)) {
      await keystroke('j', ['command', 'option']);
      vscode.window.setStatusBarMessage('Console', 1200);
      return true;
    }
    if (/^(view\s+source|page\s+source)$/i.test(tc)) {
      await keystroke('u', ['command', 'option']);
      vscode.window.setStatusBarMessage('View source', 1200);
      return true;
    }

    // ── Terminal.app / iTerm shortcuts (when using system terminal) ──
    // clear terminal (Cmd+K works in Terminal.app and iTerm)
    if (/^clear(\s+terminal|\s+screen)?$/i.test(tc)) {
      await keystroke('k', ['command']);
      vscode.window.setStatusBarMessage('Clear terminal', 1200);
      return true;
    }
    // interrupt / Ctrl+C
    if (/^(control\s+c|ctrl\s+c|interrupt|kill\s+process|stop\s+process|cancel\s+process)$/i.test(tc)) {
      await keystroke('c', ['control']);
      vscode.window.setStatusBarMessage('Ctrl+C', 1200);
      return true;
    }
    // Ctrl+D (exit / EOF)
    if (/^(control\s+d|ctrl\s+d|exit\s+terminal|exit\s+shell)$/i.test(tc)) {
      await keystroke('d', ['control']);
      vscode.window.setStatusBarMessage('Ctrl+D', 1200);
      return true;
    }
    // Ctrl+Z (suspend)
    if (/^(control\s+z|ctrl\s+z|suspend)$/i.test(tc)) {
      await keystroke('z', ['control']);
      vscode.window.setStatusBarMessage('Ctrl+Z', 1200);
      return true;
    }
    // Ctrl+R (reverse search in terminal)
    if (/^(control\s+r|ctrl\s+r|reverse\s+search|search\s+history)$/i.test(tc)) {
      await keystroke('r', ['control']);
      vscode.window.setStatusBarMessage('Reverse search', 1200);
      return true;
    }
    // Ctrl+A (beginning of line in terminal)
    if (/^(control\s+a|ctrl\s+a|beginning\s+of\s+line)$/i.test(tc)) {
      await keystroke('a', ['control']);
      return true;
    }
    // Ctrl+E (end of line in terminal)
    if (/^(control\s+e|ctrl\s+e|end\s+of\s+line)$/i.test(tc)) {
      await keystroke('e', ['control']);
      return true;
    }
    // Ctrl+U (clear line in terminal)
    if (/^(control\s+u|ctrl\s+u|clear\s+line|delete\s+line)$/i.test(tc)) {
      await keystroke('u', ['control']);
      vscode.window.setStatusBarMessage('Clear line', 1200);
      return true;
    }
    // Ctrl+W (delete word backward in terminal)
    if (/^(control\s+w|ctrl\s+w|delete\s+word)$/i.test(tc)) {
      await keystroke('w', ['control']);
      return true;
    }

    // ── Finder shortcuts ──
    if (/^(show\s+hidden\s+files|toggle\s+hidden\s+files)$/i.test(tc)) {
      await keystroke('.', ['command', 'shift']);
      return true;
    }
    if (/^(go\s+to\s+folder|go\s+to\s+path)$/i.test(tc)) {
      await keystroke('g', ['command', 'shift']);
      return true;
    }
    if (/^(new\s+folder|create\s+folder)$/i.test(tc)) {
      await keystroke('n', ['command', 'shift']);
      return true;
    }
    if (/^(get\s+info|show\s+info|file\s+info)$/i.test(tc)) {
      await keystroke('i', ['command']);
      return true;
    }

  }

  return false;
}
