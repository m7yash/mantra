import * as vscode from 'vscode';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync, ChildProcess } from 'child_process';

let currentRecProcess: ChildProcess | null = null;

/** Public: report whether we currently have an active recorder process. */
export function recorderActive(): boolean {
  return !!currentRecProcess && !currentRecProcess.killed;
}

/** Public: stop any running recorder process. */
export function pauseRecording(): void {
  if (!currentRecProcess) return;
  terminate(currentRecProcess);
  currentRecProcess = null;
}

function terminate(p: ChildProcess) {
  try {
    if (process.platform === 'win32') {
      // SIGTERM is emulated poorly on Windows; use taskkill fallback
      const pid = p.pid;
      if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
      p.kill('SIGTERM');
      // Hard kill if it lingers
      setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); }, 500);
    }
  } catch { /* noop */ }
}

/** Split args while respecting quotes so device names with spaces survive. */
function splitArgsRespectQuotes(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Check whether a demuxer exists in this ffmpeg build. */
function hasDemuxer(name: string): boolean {
  try {
    const r = spawnSync(ffmpeg as string, ['-hide_banner', '-h', `demuxer=${name}`], { encoding: 'utf8' });
    return r.status === 0 || /Demuxer .*?\b${name}\b/i.test((r.stdout || '') + (r.stderr || ''));
  } catch {
    return false;
  }
}

/** Return DirectShow default (or first) audio device display name, or null. */
function detectDshowDefaultAudio(): string | null {
  try {
    const r = spawnSync(ffmpeg as string, ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], { encoding: 'utf8' });
    const txt = (r.stderr || '') + (r.stdout || '');
    // Prefer a device marked (default)
    const def = txt.match(/"([^"]+)"\s+\(audio\).*?\(default\)/i);
    if (def) return def[1];
    const first = txt.match(/"([^"]+)"\s+\(audio\)/i);
    return first ? first[1] : null;
  } catch {
    return null;
  }
}

/**
 * Build FFmpeg input args. Allows override via MANTRA_AUDIO_INPUT.
 * - macOS: avfoundation :default (tracks System Settings)
 * - Linux: PulseAudio default
 * - Windows: WASAPI default if available, else auto-pick DirectShow default/first
 */
function buildInputArgs(): string[] {
  const override = process.env.MANTRA_AUDIO_INPUT;
  if (override && override.trim().length > 0) {
    return splitArgsRespectQuotes(override.trim());
  }

  if (process.platform === 'darwin') {
    return ['-f', 'avfoundation', '-i', ':default'];
  }
  if (process.platform === 'linux') {
    return ['-f', 'pulse', '-i', 'default'];
  }
  if (process.platform === 'win32') {
    if (hasDemuxer('wasapi')) {
      return ['-f', 'wasapi', '-i', 'default'];
    }
    const dev = detectDshowDefaultAudio();
    if (dev) {
      // Note: one arg for the full device value (no quotes needed in spawn)
      return ['-f', 'dshow', '-i', `audio=${dev}`];
    }
    // Last resort: this may still fail; user can set MANTRA_AUDIO_INPUT
    vscode.window.showWarningMessage(
      'Could not auto-detect a Windows audio device. Set MANTRA_AUDIO_INPUT, e.g. -f dshow -i "audio=Microphone (Your Device)".'
    );
    return ['-f', 'dshow', '-i', 'audio=default'];
  }
  return [];
}

/**
 * Starts one mic streaming session and passes PCM16 (16 kHz mono) to the provided handler.
 * Resolves when the handler settles. Cleans up the recorder either way.
 */
export async function startMicStream(
  _context: vscode.ExtensionContext,
  onStream: (pcmReadable: NodeJS.ReadableStream) => Promise<void>
): Promise<void> {
  // If already recording, stop the previous one first
  if (currentRecProcess) {
    pauseRecording();
    await new Promise((r) => setTimeout(r, 50));
  }

  const inputArgs = buildInputArgs();
  const ffArgs = [
    ...inputArgs,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    // Keep a small queue to reduce chance of "buffer underflow" on some hosts
    '-thread_queue_size', '4096',
    '-f', 's16le',
    '-hide_banner',
    '-loglevel', 'warning',
    'pipe:1',
  ];

  const child = spawn(ffmpeg as string, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  currentRecProcess = child;

  // Surface useful FFmpeg errors/warnings so “Listening…” isn’t silent on failure
  child.stderr?.on('data', (buf) => {
    const msg = buf.toString().trim();
    if (!msg) return;
    // Use a short-lived status message rather than spamming popups
    vscode.window.setStatusBarMessage(`FFmpeg: ${msg}`, 5000);
    // Elevate critical issues
    if (/Unknown input format|Could not find audio device|No such device|Device busy/i.test(msg)) {
      vscode.window.showWarningMessage(msg);
    }
  });

  child.on('error', (e) => {
    vscode.window.showErrorMessage(`FFmpeg failed to start: ${e instanceof Error ? e.message : String(e)}`);
  });

  // Ensure cleanup when ffmpeg exits unexpectedly
  child.on('close', () => {
    if (currentRecProcess === child) currentRecProcess = null;
  });

  try {
    if (!child.stdout) throw new Error('FFmpeg did not provide a stdout stream');
    await onStream(child.stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Stream handler error: ${msg}`);
  } finally {
    if (currentRecProcess) {
      terminate(currentRecProcess);
      currentRecProcess = null;
    }
  }
}