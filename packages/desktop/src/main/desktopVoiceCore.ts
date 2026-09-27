import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 桌面语音输入：renderer 采集 PCM16（getUserMedia）经 preload 桥送来，
 * 这里写临时 wav 并按 `~/.zcode/cli/config.json` 的 voice 段选择
 * whisper-cli（本地）或 GLM ASR（云端）转写——与 CLI TUI 版共用同一份配置。
 * 桌面包与 CLI 嵌套 workspace 分属两个 pnpm workspace，不能 import
 * `@zcode/contracts` 的 voice 类型，这里本地定义并手动 narrow。
 *
 * 静音防线（防 Whisper 对无语音音频的幻觉输出，如字幕水印句）：
 * ① renderer 波形让用户看见有没有声音 → ② 这里对 PCM 做 RMS/peak/zeroRatio
 * 预检，全零/极低电平直接判空 → ③ whisper-cli 启用 Silero VAD（ggml-silero
 * 模型），无有效人声段时 whisper 输出为空。参数取 whisper.cpp 与 Silero 官方
 * 默认的折中（编程 prompt 场景留更大 speech pad 与静音容忍）。
 */

export const VOICE_TRANSCRIBE_CHANNEL = "voice:transcribe";

const VOICE_TRANSCRIBE_TIMEOUT_MS = 120_000;
export const VOICE_MAX_PCM_SAMPLES = 16_000 * 300; // 5 分钟上限
export const VOICE_MIN_PCM_SAMPLES = 1_600; // <0.1s 视为误触
const WHISPER_THREADS = 8;
const MAX_WHISPER_OUTPUT_CHARS = 64_000;
const MAX_ERROR_DETAIL_CHARS = 300;
const VAD_MODEL_FILENAME = "ggml-silero-v6.2.0.bin";
const VAD_THRESHOLD = 0.45;
const VAD_MIN_SPEECH_MS = 180;
const VAD_MIN_SILENCE_MS = 350;
const VAD_SPEECH_PAD_MS = 200;
const PCM_SILENCE_RMS = 1e-4;
const PCM_SILENCE_ZERO_RATIO = 0.999;

export type DesktopVoiceConfig = {
  asrProvider: "whisper-local" | "glm";
  glmApiKey?: string;
  glmBaseUrl: string;
  glmModel: string;
  language: string;
  whisperBin: string;
  whisperModelPath?: string;
  vadModelPath?: string;
};

const DEFAULT_VOICE_CONFIG: DesktopVoiceConfig = {
  asrProvider: "whisper-local",
  glmBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  glmModel: "glm-asr",
  language: "zh",
  whisperBin: "whisper-cli",
};

function resolveVoiceConfigPath(env: NodeJS.ProcessEnv): string {
  const storageRoot = env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode");
  return join(storageRoot, "cli", "config.json");
}

/** 读 CLI 配置文件的 voice 段；缺失/非法键回落默认值，不抛错。 */
export async function readDesktopVoiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopVoiceConfig> {
  const raw = await readFile(resolveVoiceConfigPath(env), "utf8").catch(() => undefined);
  if (!raw) return { ...DEFAULT_VOICE_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_VOICE_CONFIG };
  }
  const voice = (parsed as { voice?: unknown }).voice;
  if (typeof voice !== "object" || voice === null) return { ...DEFAULT_VOICE_CONFIG };
  const source = voice as Record<string, unknown>;
  const config: DesktopVoiceConfig = { ...DEFAULT_VOICE_CONFIG };
  if (source.asrProvider === "glm" || source.asrProvider === "whisper-local") {
    config.asrProvider = source.asrProvider;
  }
  for (const key of ["glmApiKey", "glmBaseUrl", "glmModel", "language", "whisperBin"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) config[key] = value.trim();
  }
  if (typeof source.whisperModelPath === "string" && source.whisperModelPath.trim()) {
    config.whisperModelPath = source.whisperModelPath.trim();
  }
  if (typeof source.vadModelPath === "string" && source.vadModelPath.trim()) {
    config.vadModelPath = source.vadModelPath.trim();
  }
  return config;
}

/** VAD 模型解析：显式配置优先；否则探测 whisper 模型同目录的内置命名文件。 */
export function resolveVadModelPath(config: DesktopVoiceConfig): string | undefined {
  const explicit = config.vadModelPath?.trim();
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  if (!config.whisperModelPath) return undefined;
  const candidate = join(dirname(config.whisperModelPath), VAD_MODEL_FILENAME);
  return existsSync(candidate) ? candidate : undefined;
}

export type PcmHealth = {
  peak: number;
  rms: number;
  zeroRatio: number;
};

/** PCM16 采集健康检查：全零/极低电平（坏麦克风、错误设备）直接判空。 */
export function analyzePcm16(pcm16: Int16Array): PcmHealth {
  let peak = 0;
  let squareSum = 0;
  let zeroCount = 0;
  for (let index = 0; index < pcm16.length; index += 1) {
    const sample = Math.abs(pcm16[index] ?? 0);
    if (sample > peak) peak = sample;
    squareSum += sample * sample;
    if (sample === 0) zeroCount += 1;
  }
  const count = Math.max(1, pcm16.length);
  return {
    peak: peak / 32_768,
    rms: Math.sqrt(squareSum / count) / 32_768,
    zeroRatio: zeroCount / count,
  };
}

export function isSilentPcm(health: PcmHealth): boolean {
  return health.rms < PCM_SILENCE_RMS && health.zeroRatio > PCM_SILENCE_ZERO_RATIO;
}

/** PCM16 mono → 44 字节头的 RIFF/WAV Buffer。 */
export function encodeWav(pcm16: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm16.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < pcm16.length; index += 1) {
    buffer.writeInt16LE(pcm16[index], 44 + index * 2);
  }
  return buffer;
}

/**
 * whisper-cli 参数。注意：**不加 -nt**——流式蹦字需要段级时间戳对齐
 * （stable-prefix 合并依赖段时间轴），stdout 输出形如
 * `[00:00:00.000 --> 00:00:02.000] 文本`，由 parseWhisperSegments 解析。
 * prompt：initial_prompt 注入已确认前文 + 技术词，给模型上下文减少同音字。
 */
export function buildWhisperArgs(
  config: DesktopVoiceConfig,
  wavPath: string,
  vadModelPath?: string,
  prompt?: string,
): string[] {
  const args = [
    "-m",
    config.whisperModelPath ?? "",
    "-l",
    config.language,
    "-t",
    String(WHISPER_THREADS),
  ];
  if (vadModelPath) {
    // Silero VAD 挡静音幻觉：无有效人声段时 whisper 输出为空。
    args.push("--vad", "-vm", vadModelPath, "-vt", String(VAD_THRESHOLD));
    args.push("-vspd", String(VAD_MIN_SPEECH_MS));
    args.push("-vsd", String(VAD_MIN_SILENCE_MS));
    args.push("-vp", String(VAD_SPEECH_PAD_MS));
  }
  if (prompt?.trim()) {
    args.push("--prompt", prompt.trim());
  }
  args.push("-f", wavPath);
  return args;
}

export type DesktopWhisperSegment = {
  /** 段起始（秒，相对本次转写的 wav 起点）。 */
  start: number;
  /** 段结束（秒）。 */
  end: number;
  text: string;
};

const WHISPER_SEGMENT_LINE =
  /^\s*\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/u;

/** 解析 whisper-cli stdout 的段时间戳行（stderr 的系统日志不经此）。 */
export function parseWhisperSegments(stdout: string): DesktopWhisperSegment[] {
  const segments: DesktopWhisperSegment[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = WHISPER_SEGMENT_LINE.exec(line);
    if (!match) continue;
    const toSeconds = (h: string, m: string, s: string, ms: string): number =>
      Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    const start = toSeconds(match[1] ?? "0", match[2] ?? "0", match[3] ?? "0", match[4] ?? "0");
    const end = toSeconds(match[5] ?? "0", match[6] ?? "0", match[7] ?? "0", match[8] ?? "0");
    const text = (match[9] ?? "").trim();
    if (text) segments.push({ start, end, text });
  }
  return segments;
}

export async function transcribeWithWhisper(
  config: DesktopVoiceConfig,
  wavPath: string,
  prompt?: string,
): Promise<DesktopWhisperSegment[]> {
  const vadModelPath = resolveVadModelPath(config);
  return await new Promise<DesktopWhisperSegment[]>((resolve, reject) => {
    const child = spawn(
      config.whisperBin,
      buildWhisperArgs(config, wavPath, vadModelPath, prompt),
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutChars = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChars += chunk.length;
      if (stdoutChars <= MAX_WHISPER_OUTPUT_CHARS) stdoutChunks.push(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrChunks.join("").length < MAX_ERROR_DETAIL_CHARS) {
        stderrChunks.push(chunk.toString("utf8"));
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`[voice] whisper timed out after ${VOICE_TRANSCRIBE_TIMEOUT_MS}ms`));
    }, VOICE_TRANSCRIBE_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`[voice] failed to start whisper: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(parseWhisperSegments(stdoutChunks.join("")));
        return;
      }
      const detail = stderrChunks.join("").trim() || `exit code ${code ?? "null"}`;
      reject(new Error(`[voice] whisper failed: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`));
    });
  });
}

/** GLM ASR 无段时间戳，包装成覆盖整个 wav 的单段（秒数由调用方补齐时长）。 */
export async function transcribeWithGlm(
  config: DesktopVoiceConfig,
  wavPath: string,
  durationSeconds: number,
): Promise<DesktopWhisperSegment[]> {
  const audio = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "recording.wav");
  form.append("model", config.glmModel);
  const base = config.glmBaseUrl.replace(/\/+$/u, "");
  const response = await fetch(`${base}/audio/transcriptions`, {
    body: form,
    headers: { Authorization: `Bearer ${config.glmApiKey ?? ""}` },
    method: "POST",
    signal: AbortSignal.timeout(VOICE_TRANSCRIBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`[voice] GLM ASR HTTP ${response.status}`);
  const data = (await response.json()) as { text?: unknown };
  if (typeof data.text !== "string") throw new Error("[voice] GLM ASR response has no text field");
  return [{ start: 0, end: durationSeconds, text: data.text }];
}

export async function createVoiceTempDirectory(env: NodeJS.ProcessEnv): Promise<string> {
  const storageRoot = env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode");
  const voiceRoot = join(storageRoot, "voice");
  await mkdir(voiceRoot, { recursive: true });
  return mkdtemp(join(voiceRoot, "desktop-rec-"));
}
