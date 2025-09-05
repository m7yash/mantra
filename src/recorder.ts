import * as vscode from 'vscode';
import ffmpeg from 'ffmpeg-static';
import { spawn, ChildProcess } from 'child_process';

let currentRecProcess: ChildProcess | null = null;

/**
 * Build FFmpeg input args. Allows override via MANTRA_AUDIO_INPUT.
 * On macOS, use AVFoundation’s :default so it follows the mic set in System Settings.
 */
function buildInputArgs(): string[] {
  const override = process.env.MANTRA_AUDIO_INPUT;
  if (override && override.trim().length > 0) {
    // Keep the original simple behavior; users can quote args in the env var if needed.
    return override.split(' ').filter(Boolean);
  }

  if (process.platform === 'darwin') {
    // Respect the system-selected input device (e.g., “Blue Snowball”)
    return ['-f', 'avfoundation', '-i', ':default'];
  }
  if (process.platform === 'linux') {
    return ['-f', 'pulse', '-i', 'default'];
  }
  if (process.platform === 'win32') {
    // Prefer WASAPI default; users can override with MANTRA_AUDIO_INPUT
    return ['-f', 'wasapi', '-i', 'default'];
  }
  return [];
}

function terminate(child: ChildProcess) {
  try { child.kill('SIGINT'); } catch { }
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, 750);
  child.once('exit', () => clearTimeout(t));
}

export function pauseRecording() {
  if (currentRecProcess) {
    terminate(currentRecProcess);
    currentRecProcess = null;
  }
}

export function recorderActive(): boolean {
  return !!currentRecProcess;
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

  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'warning',
    ...buildInputArgs(),
    '-ac', '1',
    '-ar', '16000',
    '-f', 's16le',
    'pipe:1',
  ];

  const bin = (ffmpeg || '') as string;
  if (!bin) {
    vscode.window.showErrorMessage('FFmpeg binary not found');
    return;
  }

  const child: ChildProcess = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  currentRecProcess = child;

  // Surface FFmpeg stderr to the console so device/permission issues aren’t silent
  child.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log('[ffmpeg]', msg);
  });

  child.once('error', (err) => {
    console.log('[ffmpeg:error]', err);
    if (currentRecProcess === child) currentRecProcess = null;
  });

  child.once('exit', () => {
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