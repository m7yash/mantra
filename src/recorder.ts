import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import ffmpegStatic from 'ffmpeg-static';
import { spawn, spawnSync, ChildProcess } from 'child_process';

let currentRecProcess: ChildProcess | null = null;
let currentMicName: string = '';

export function getMicName(): string { return currentMicName; }

// ---------- volume metering ----------
let volumeCallback: ((level: number) => void) | null = null;
let lastVolumeTime = 0;
const VOLUME_THROTTLE_MS = 80; // ~12fps

export function onVolume(cb: (level: number) => void): void { volumeCallback = cb; }
export function offVolume(): void { volumeCallback = null; }

function computeRms(buf: Buffer): number {
  const samples = Math.floor(buf.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples) / 32768;
}

// ---------- logging ----------
let recorderLog: vscode.OutputChannel | null = null;
function logInfo(msg: string) {
  if (!recorderLog) recorderLog = vscode.window.createOutputChannel('Mantra Recorder');
  recorderLog.appendLine(`[info] ${msg}`);
}
function logWarn(msg: string) {
  if (!recorderLog) recorderLog = vscode.window.createOutputChannel('Mantra Recorder');
  recorderLog.appendLine(`[warn] ${msg}`);
}
function logError(msg: string) {
  if (!recorderLog) recorderLog = vscode.window.createOutputChannel('Mantra Recorder');
  recorderLog.appendLine(`[error] ${msg}`);
}
function status(msg: string, ms = 4000) {
  vscode.window.setStatusBarMessage(msg, ms);
}

// ---------- public API ----------
export function recorderActive(): boolean {
  return !!currentRecProcess && !currentRecProcess.killed;
}

export function pauseRecording(): void {
  if (!currentRecProcess) return;
  terminate(currentRecProcess);
  currentRecProcess = null;
  if (volumeCallback) volumeCallback(0);
  status('⏸️ Recording stopped.');
  logInfo('Recording stopped.');
}

// ---------- helpers ----------
function terminate(p: ChildProcess) {
  try {
    if (process.platform === 'win32') {
      const pid = p.pid;
      if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
      p.kill('SIGTERM');
      setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); }, 500);
    }
  } catch (e) {
    logWarn(`terminate(): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function splitArgsRespectQuotes(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function runningInWSL(): boolean {
  try {
    if (process.env.WSL_DISTRO_NAME) return true;
    const rel = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8');
    return /microsoft/i.test(rel);
  } catch { return false; }
}

function wslgAvailable(): boolean {
  try {
    if (process.env.PULSE_SERVER) return true;
    return fs.existsSync('/mnt/wslg/PulseServer');
  } catch { return false; }
}

function ensureDir(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

// ---------- ffmpeg resolution (env → static → PATH → Win download) ----------
function findFfmpegExe(baseDir: string): string | null {
  const target = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (!fs.existsSync(baseDir)) return null;
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

async function downloadToFile(url: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    const handle = (res: any) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, handle).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      file.on('finish', () => {
        file.close(err => err ? reject(err) : resolve());
      });
      res.pipe(file);
      res.on('error', reject);
    };

    https.get(url, handle).on('error', reject);
  });
}

async function extractZipWindows(zipPath: string, destDir: string) {
  // Try PowerShell Expand-Archive first (present on Win10+)
  const ps = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`
  ], { encoding: 'utf8' });

  if (ps.status === 0) return;

  // Fallback to 'tar' if available (Windows ships bsdtar on many builds)
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { encoding: 'utf8' });
  if (tar.status === 0) return;

  throw new Error(`Failed to extract FFmpeg ZIP.\nPowerShell: ${ps.stderr || ps.stdout}\nTar: ${tar.stderr || tar.stdout}`);
}

async function resolveFfmpegPath(context: vscode.ExtensionContext): Promise<string> {
  const override = process.env.MANTRA_FFMPEG_PATH;
  if (override && fs.existsSync(override)) {
    logInfo(`Using FFmpeg from MANTRA_FFMPEG_PATH: ${override}`);
    return override;
  }

  const staticPath = (ffmpegStatic as unknown as string) || '';
  if (staticPath && fs.existsSync(staticPath)) {
    logInfo(`Using FFmpeg from ffmpeg-static: ${staticPath}`);
    return staticPath;
  }

  // Try PATH
  const cmd = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  try {
    const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
    if (r.status === 0) {
      logInfo(`Using FFmpeg from PATH: ${cmd}`);
      return cmd;
    }
  } catch {
    /* not on PATH */
  }

  // Windows last-resort: auto-download a fresh binary and cache it
  if (process.platform === 'win32') {
    const storeDir = path.join(context.globalStorageUri.fsPath, 'ffmpeg-win');
    ensureDir(context.globalStorageUri.fsPath);
    ensureDir(storeDir);

    const cached = findFfmpegExe(storeDir);
    if (cached) {
      logInfo(`Using cached FFmpeg: ${cached}`);
      return cached;
    }

    const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
    const tmpZip = path.join(os.tmpdir(), `ffmpeg-release-essentials-${Date.now()}.zip`);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Downloading FFmpeg (Windows)…', cancellable: false },
      async () => {
        status('⬇️ Downloading FFmpeg…');
        logInfo(`Downloading FFmpeg from: ${url}`);
        ensureDir(storeDir);
        await downloadToFile(url, tmpZip);
        status('📦 Extracting FFmpeg…');
        await extractZipWindows(tmpZip, storeDir);
        try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
      }
    );

    const found = findFfmpegExe(storeDir);
    if (found) {
      logInfo(`Using newly downloaded FFmpeg: ${found}`);
      return found;
    }
    throw new Error('FFmpeg download/extract completed, but ffmpeg.exe was not found.');
  }

  throw new Error('FFmpeg not found. Set MANTRA_FFMPEG_PATH to your ffmpeg binary, or install FFmpeg and ensure it is on PATH.');
}

// ---------- input selection ----------
function listDshowAudioDevices(ffmpegCmd: string): string[] {
  try {
    const r = spawnSync(
      ffmpegCmd,
      ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'],
      { encoding: 'utf8' }
    );
    const txt = (r.stderr || '') + (r.stdout || '');
    const all: { name: string; isDefault: boolean }[] = [];
    const re = /"([^"]+)"\s+\(audio\)([^\n]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) !== null) {
      const name = m[1];
      const isDefault = /\(default\)/i.test(m[2] || '');
      all.push({ name, isDefault });
    }
    if (all.length === 0) return [];
    all.sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1));
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const it of all) {
      if (!seen.has(it.name)) { seen.add(it.name); ordered.push(it.name); }
    }
    return ordered;
  } catch (e) {
    logWarn(`listDshowAudioDevices(): ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function probeInput(ffmpegCmd: string, inputArgs: string[]): { ok: boolean; detail: string } {
  try {
    const args = [
      ...inputArgs,
      '-t', '0.25',
      '-f', 'null', '-',
      '-hide_banner',
      '-loglevel', 'error'
    ];
    const r = spawnSync(ffmpegCmd, args, { encoding: 'utf8', timeout: 4000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0;
    return { ok, detail: out.trim().split(/\r?\n/).slice(-4).join(' | ') || (ok ? 'OK' : 'fail') };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function buildNonWindowsInputArgs(): string[] {
  if (process.platform === 'darwin') return ['-f', 'avfoundation', '-i', ':default'];
  if (process.platform === 'linux') return ['-f', 'pulse', '-i', 'default'];
  return [];
}

function buildWindowsCandidates(ffmpegCmd: string): string[][] {
  const candidates: string[][] = [];
  const override = process.env.MANTRA_AUDIO_INPUT;
  if (override && override.trim().length > 0) {
    candidates.push(splitArgsRespectQuotes(override.trim()));
  }
  // WASAPI default first (if the build has it)
  candidates.push(['-f', 'wasapi', '-i', 'default']);

  // All enumerated DirectShow audio devices (default first)
  const devices = listDshowAudioDevices(ffmpegCmd);
  for (const dev of devices) {
    candidates.push(['-f', 'dshow', '-i', `audio=${dev}`]);
  }

  // Last resort
  candidates.push(['-f', 'dshow', '-i', 'audio=default']);
  return candidates;
}

// ---------- main entry ----------
export async function startMicStream(
  context: vscode.ExtensionContext,
  onStream: (pcmReadable: NodeJS.ReadableStream) => Promise<void>
): Promise<void> {
  // Stop an existing process first
  if (currentRecProcess) {
    pauseRecording();
    await new Promise((r) => setTimeout(r, 50));
  }

  let ffmpegCmd: string;
  try {
    ffmpegCmd = await resolveFfmpegPath(context);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError(`FFmpeg resolution failed: ${msg}`);
    vscode.window.showErrorMessage(msg);
    return;
  }

  // WSL2 without WSLg has no Linux audio server → no mic
  if (process.platform === 'linux' && runningInWSL() && !wslgAvailable()) {
    const help = 'No Linux audio server detected. In WSL2 without WSLg there is no microphone device. Enable WSLg or run the extension on the Windows host.';
    logError(help);
    vscode.window.showErrorMessage(help);
    return;
  }

  logInfo(`Platform: ${process.platform}`);

  const cfgOverrideRaw = (vscode.workspace.getConfiguration('mantra').get<string>('microphoneInput', '') || '').trim();
  const envOverrideRaw = (process.env.MANTRA_AUDIO_INPUT || '').trim();
  const override = cfgOverrideRaw || envOverrideRaw;

  if (override) logInfo(`Microphone override: ${override}`);

  // Choose input
  let chosenInput: string[] | null = null;

  if (override) {
    chosenInput = splitArgsRespectQuotes(override);
  } else if (process.platform === 'win32') {
    const candidates = buildWindowsCandidates(ffmpegCmd);
    logInfo(`Trying ${candidates.length} Windows input candidates…`);
    for (const c of candidates) {
      logInfo(`Probing: ${JSON.stringify(c)}`);
      const res = probeInput(ffmpegCmd, c);
      logInfo(`Probe result: ${res.ok ? 'OK' : 'FAIL'} (${res.detail})`);
      if (res.ok) { chosenInput = c; break; }
    }
    if (!chosenInput) {
      const help = 'No Windows audio input could be opened via WASAPI/DShow. Set **Settings → Mantra → Microphone Input** or MANTRA_AUDIO_INPUT (e.g. -f dshow -i "audio=Microphone (Your Device)").';
      logError(help);
      vscode.window.showErrorMessage(help);
      return;
    }
  } else {
    chosenInput = buildNonWindowsInputArgs();
  }

  // Resolve actual microphone device name from ffmpeg
  const micName = (() => {
    const iIdx = chosenInput!.indexOf('-i');
    const fIdx = chosenInput!.indexOf('-f');
    const format = fIdx >= 0 && fIdx + 1 < chosenInput!.length ? chosenInput![fIdx + 1] : '';
    const rawInput = iIdx >= 0 && iIdx + 1 < chosenInput!.length ? chosenInput![iIdx + 1] : '';

    // On macOS, query AVFoundation to resolve index/default to a real name
    if (format === 'avfoundation') {
      try {
        const r = spawnSync(ffmpegCmd, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8', timeout: 3000 });
        const out = (r.stdout || '') + (r.stderr || '');
        const lines = out.split(/\r?\n/);
        const audioStart = lines.findIndex(l => /AVFoundation audio devices/i.test(l));
        if (audioStart >= 0) {
          // Parse audio index from input — ":default" or ":0" or ":2"
          const audioIdx = rawInput.replace(/^:/, '');
          if (audioIdx === 'default' || audioIdx === '') {
            // First audio device is the default
            for (let i = audioStart + 1; i < lines.length; i++) {
              if (/AVFoundation video devices/i.test(lines[i])) break;
              const m = lines[i].match(/\[\d+\]\s*(?:"([^"]+)"|(.+))$/);
              if (m) return (m[1] || m[2] || '').trim();
            }
          } else {
            // Find specific index
            for (let i = audioStart + 1; i < lines.length; i++) {
              if (/AVFoundation video devices/i.test(lines[i])) break;
              const m = lines[i].match(/\[(\d+)\]\s*(?:"([^"]+)"|(.+))$/);
              if (m && m[1] === audioIdx) return (m[2] || m[3] || '').trim();
            }
          }
        }
      } catch { /* fall through */ }
      return rawInput || 'default';
    }

    // On Windows, strip "audio=" prefix for DirectShow names
    if (format === 'dshow') return rawInput.replace(/^audio=/, '') || 'default';
    // On Linux, PulseAudio source name
    if (format === 'pulse') return rawInput || 'default';
    // Fallback
    return rawInput || chosenInput!.join(' ');
  })();
  currentMicName = micName;
  logInfo(`Using microphone: ${micName} (raw: ${JSON.stringify(chosenInput)})`);
  console.log(`[Mantra] 🎙️ Microphone: ${micName}`);
  status(`🎙️ Mic: ${micName}`);

  const ffArgs = [
    ...chosenInput!,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 's16le',
    '-hide_banner',
    '-loglevel', 'warning',
    'pipe:1',
  ];
  logInfo(`Spawn: ${ffmpegCmd} ${ffArgs.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

  const child = spawn(ffmpegCmd, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  currentRecProcess = child;

  child.stderr?.on('data', (buf) => {
    const msg = buf.toString().trim();
    if (!msg) return;
    logWarn(`ffmpeg: ${msg}`);
    status(`FFmpeg: ${msg}`, 3000);
    if (/Unknown input format|Could not find audio device|No such device|Device busy|permission|PulseAudio:.*Connection refused|ALSA lib/i.test(msg)) {
      vscode.window.showWarningMessage(msg);
    }
  });

  child.on('error', (e) => {
    const m = e instanceof Error ? e.message : String(e);
    logError(`FFmpeg failed to start: ${m}`);
    vscode.window.showErrorMessage(`FFmpeg failed to start: ${m}`);
  });

  child.on('close', (code, signal) => {
    logInfo(`FFmpeg exited (code=${code}, signal=${signal ?? 'none'})`);
    if (currentRecProcess === child) currentRecProcess = null;
  });

  try {
    if (!child.stdout) throw new Error('FFmpeg did not provide a stdout stream.');

    // Volume metering: tap PCM data for RMS level (throttled)
    if (volumeCallback) {
      child.stdout.on('data', (chunk: Buffer) => {
        const now = Date.now();
        if (now - lastVolumeTime < VOLUME_THROTTLE_MS) return;
        lastVolumeTime = now;
        if (volumeCallback) volumeCallback(computeRms(chunk));
      });
    }

    logInfo('Microphone stream ready; handing off PCM to consumer.');
    await onStream(child.stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Stream handler error: ${msg}`);
    // Re-throw so the caller's retry logic (e.g. concurrent-session backoff) can handle it
    throw err;
  } finally {
    if (currentRecProcess) {
      terminate(currentRecProcess);
      currentRecProcess = null;
      logInfo('Recording process terminated (cleanup).');
    }
    status('✅ Microphone session ended.', 3000);
  }
}

// ---------- mic test (volume meter only, no STT) ----------
let testProcess: ChildProcess | null = null;

export async function testMic(
  context: vscode.ExtensionContext,
  onLevel: (level: number, micName: string) => void
): Promise<void> {
  stopMicTest();

  let ffmpegCmd: string;
  try {
    ffmpegCmd = await resolveFfmpegPath(context);
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    return;
  }

  const cfgRaw = (vscode.workspace.getConfiguration('mantra').get<string>('microphoneInput', '') || '').trim();
  const envRaw = (process.env.MANTRA_AUDIO_INPUT || '').trim();
  const override = cfgRaw || envRaw;

  let chosenInput: string[] | null = null;
  if (override) {
    chosenInput = splitArgsRespectQuotes(override);
  } else if (process.platform === 'win32') {
    const candidates = buildWindowsCandidates(ffmpegCmd);
    for (const c of candidates) {
      if (probeInput(ffmpegCmd, c).ok) { chosenInput = c; break; }
    }
    if (!chosenInput) {
      vscode.window.showErrorMessage('No audio input found. Use "Mantra: Select Microphone" first.');
      return;
    }
  } else {
    chosenInput = buildNonWindowsInputArgs();
  }

  // Resolve mic name (simplified)
  const iIdx = chosenInput.indexOf('-i');
  const rawInput = iIdx >= 0 && iIdx + 1 < chosenInput.length ? chosenInput[iIdx + 1] : '';
  const name = rawInput.replace(/^audio=/, '').replace(/^:/, '') || 'default';

  const ffArgs = [...chosenInput, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-hide_banner', '-loglevel', 'warning', 'pipe:1'];
  const child = spawn(ffmpegCmd, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  testProcess = child;

  child.stderr?.on('data', () => {}); // drain

  let lastT = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    const now = Date.now();
    if (now - lastT < VOLUME_THROTTLE_MS) return;
    lastT = now;
    onLevel(computeRms(chunk), name);
  });

  // Keep the promise alive until the process exits
  return new Promise<void>((resolve) => {
    child.on('error', () => { testProcess = null; resolve(); });
    child.on('close', () => { if (testProcess === child) testProcess = null; resolve(); });
  });
}

export function stopMicTest(): void {
  if (!testProcess) return;
  terminate(testProcess);
  testProcess = null;
}

export function isMicTesting(): boolean {
  return !!testProcess && !testProcess.killed;
}