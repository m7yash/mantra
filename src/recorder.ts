import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import ffmpegStatic from 'ffmpeg-static';
import { spawn, spawnSync, ChildProcess } from 'child_process';

let currentRecProcess: ChildProcess | null = null;

/** Public: is a recorder process active? */
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
      const pid = p.pid;
      if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
      p.kill('SIGTERM');
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
function hasDemuxer(ffmpegCmd: string, name: string): boolean {
  try {
    const r = spawnSync(ffmpegCmd, ['-hide_banner', '-h', `demuxer=${name}`], { encoding: 'utf8' });
    return r.status === 0 || new RegExp(`\\b${name}\\b`, 'i').test((r.stdout || '') + (r.stderr || ''));
  } catch {
    return false;
  }
}

/** Return DirectShow default (or first) audio device display name, or null. */
function detectDshowDefaultAudio(ffmpegCmd: string): string | null {
  try {
    const r = spawnSync(ffmpegCmd, ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], { encoding: 'utf8' });
    const txt = (r.stderr || '') + (r.stdout || '');
    const def = txt.match(/"([^"]+)"\s+\(audio\).*?\(default\)/i);
    if (def) return def[1];
    const first = txt.match(/"([^"]+)"\s+\(audio\)/i);
    return first ? first[1] : null;
  } catch {
    return null;
  }
}

/** Find an ffmpeg.exe inside baseDir (recursive). */
function findFfmpegExe(baseDir: string): string | null {
  const target = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const stack: string[] = [baseDir];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase() === target) return p;
    }
  }
  return null;
}

/** Download a file to dest (Windows fallback). */
async function downloadToFile(url: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    const handle = (res: any) => {
      // follow a single redirect if present
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, handle).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      // Resolve only after the file stream has flushed all data and closed
      file.on('finish', () => {
        file.close((err) => (err ? reject(err) : resolve()));
      });

      res.pipe(file);
      res.on('error', reject);
    };

    https.get(url, handle).on('error', reject);
  });
}

/**
 * Ensure an ffmpeg path exists.
 * Order:
 * 1) MANTRA_FFMPEG_PATH (if exists)
 * 2) ffmpeg-static path (if file exists in this package)
 * 3) system PATH (ffmpeg[-.exe])
 * 4) Windows-only: auto-download latest release essentials zip from gyan.dev,
 *    extract to global storage, and use that binary.
 */
async function resolveFfmpegPath(context: vscode.ExtensionContext): Promise<string> {
  const override = process.env.MANTRA_FFMPEG_PATH;
  if (override && fs.existsSync(override)) return override;

  const staticPath = (ffmpegStatic as unknown as string) || '';
  if (staticPath && fs.existsSync(staticPath)) return staticPath;

  // Try PATH
  const cmd = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  try {
    const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
    if (r.status === 0) return cmd;
  } catch { /* not on PATH */ }

  // Windows last-resort: download and cache ffmpeg
  if (process.platform === 'win32') {
    const storeDir = path.join(context.globalStorageUri.fsPath, 'ffmpeg-win');
    const exePath = findFfmpegExe(storeDir);
    if (exePath && fs.existsSync(exePath)) return exePath;

    // Stable "latest release essentials" ZIP link (contains ffmpeg.exe).
    const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
    const tmpZip = path.join(os.tmpdir(), `ffmpeg-release-essentials-${Date.now()}.zip`);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Downloading FFmpeg (Windows)…', cancellable: false },
      async () => {
        fs.mkdirSync(storeDir, { recursive: true });
        await downloadToFile(url, tmpZip);
        // Use PowerShell Expand-Archive (avoids adding unzip deps)
        const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path "${tmpZip}" -DestinationPath "${storeDir}" -Force`], { encoding: 'utf8' });
        if (ps.status !== 0) throw new Error(`Failed to extract FFmpeg ZIP: ${ps.stderr || ps.stdout || 'unknown error'}`);
        try { fs.unlinkSync(tmpZip); } catch {}
      }
    );

    const found = findFfmpegExe(storeDir);
    if (found) return found;

    throw new Error('FFmpeg download succeeded but ffmpeg.exe was not found after extraction.');
  }

  throw new Error('FFmpeg not found. Set MANTRA_FFMPEG_PATH to your ffmpeg binary, or install FFmpeg and ensure it is on PATH.');
}

/**
 * Build FFmpeg input args. Allows override via MANTRA_AUDIO_INPUT.
 * - macOS: avfoundation :default (tracks System Settings)
 * - Linux: PulseAudio default
 * - Windows: WASAPI default if available, else auto-pick DirectShow default/first
 */
function buildInputArgs(ffmpegCmd: string): string[] {
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
    if (hasDemuxer(ffmpegCmd, 'wasapi')) {
      return ['-f', 'wasapi', '-i', 'default'];
    }
    const dev = detectDshowDefaultAudio(ffmpegCmd);
    if (dev) {
      return ['-f', 'dshow', '-i', `audio=${dev}`];
    }
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
  context: vscode.ExtensionContext,
  onStream: (pcmReadable: NodeJS.ReadableStream) => Promise<void>
): Promise<void> {
  // If already recording, stop the previous one first
  if (currentRecProcess) {
    pauseRecording();
    await new Promise((r) => setTimeout(r, 50));
  }

  let ffmpegCmd: string;
  try {
    ffmpegCmd = await resolveFfmpegPath(context);
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    return;
  }

  const inputArgs = buildInputArgs(ffmpegCmd);
  const ffArgs = [
    ...inputArgs,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 's16le',
    '-hide_banner',
    '-loglevel', 'warning',
    'pipe:1',
  ];

  const child = spawn(ffmpegCmd, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  currentRecProcess = child;

  // Surface useful FFmpeg messages so “Listening…” isn’t silent on failure
  child.stderr?.on('data', (buf) => {
    const msg = buf.toString().trim();
    if (!msg) return;
    vscode.window.setStatusBarMessage(`FFmpeg: ${msg}`, 5000);
    if (/Unknown input format|Could not find audio device|No such device|Device busy/i.test(msg)) {
      vscode.window.showWarningMessage(msg);
    }
  });

  child.on('error', (e) => {
    vscode.window.showErrorMessage(`FFmpeg failed to start: ${e instanceof Error ? e.message : String(e)}`);
  });

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