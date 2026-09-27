import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeConfig } from "@zcode/contracts";
import type {
  TuiVoiceErrorCode,
  TuiVoiceInput,
  TuiVoiceInputError,
  TuiVoiceSession,
} from "@zcode/tui";

const RECORD_SAMPLE_RATE_HZ = 16_000;
const RECORD_CHANNELS = 1;
const RECORD_BITS = 16;
const RECORD_STARTUP_PROBE_MS = 1_500;
const RECORD_STOP_TIMEOUT_MS = 3_000;
const RECORD_KILL_TIMEOUT_MS = 500;
const MIN_RECORDED_BYTES = 1_024;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const WHISPER_THREADS = 8;
const VAD_MODEL_FILENAME = "ggml-silero-v6.2.0.bin";
const VAD_THRESHOLD = 0.45;
const VAD_MIN_SPEECH_MS = 180;
const VAD_MIN_SILENCE_MS = 350;
const VAD_SPEECH_PAD_MS = 200;
const MAX_WHISPER_OUTPUT_CHARS = 64_000;
const MAX_ERROR_DETAIL_CHARS = 300;

export class NodeVoiceInputError extends Error implements TuiVoiceInputError {
  readonly code: TuiVoiceErrorCode;

  constructor(code: TuiVoiceErrorCode, message: string) {
    super(message);
    this.name = "NodeVoiceInputError";
    this.code = code;
  }
}

type VoiceRecorderProcess = {
  kill(signal?: NodeJS.Signals): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  stderr: import("node:stream").Readable | null;
};

type SpawnVoiceProcess = (
  file: string,
  args: string[],
  options: { stdio: ["ignore", "ignore", "pipe"] },
) => VoiceRecorderProcess;

type WhisperCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type RunWhisperCommand = (
  file: string,
  args: string[],
  options: { maxOutputChars: number; timeoutMs: number },
) => Promise<WhisperCommandResult>;

export type VoiceFetch = (
  input: string,
  init: {
    body: FormData;
    headers: Record<string, string>;
    method: "POST";
    signal: AbortSignal;
  },
) => Promise<Response>;

export type NodeVoiceInputOptions = {
  config: RuntimeConfig["voice"];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: VoiceFetch;
  platform?: NodeJS.Platform;
  runWhisperCommand?: RunWhisperCommand;
  spawnProcess?: SpawnVoiceProcess;
};

type RecorderSessionState = {
  earlyFailure: Error | undefined;
  exited: boolean;
  exitWaiters: Array<() => void>;
  recorder: VoiceRecorderProcess;
  spawnStartedAt: number;
  stderrChunks: string[];
  stopRequested: boolean;
};

// Registry so CLI shutdown handlers can discard recordings instead of
// leaking a detached recorder process when the process exits mid-session.
const activeSessions = new Set<{ cancel(): Promise<void> }>();

export async function disposeActiveVoiceSessions(): Promise<void> {
  await Promise.allSettled([...activeSessions].map((session) => session.cancel()));
}

export function createNodeVoiceInput(options: NodeVoiceInputOptions): TuiVoiceInput {
  const env = options.env ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async beginSession() {
      validateVoiceConfig(options.config);
      const directory = await createVoiceTempDirectory(env);
      const wavPath = join(directory, "recording.wav");
      const state = spawnRecorder(options.config, spawnProcess, wavPath);
      // Reject fast when the recorder dies immediately (missing binary,
      // microphone permission denied) instead of failing at stop time.
      const recorderAlive = await waitUntil(state, RECORD_STARTUP_PROBE_MS);
      if (!recorderAlive || state.earlyFailure) {
        await safeRemoveDirectory(directory);
        throw (
          state.earlyFailure ??
          new NodeVoiceInputError("start_failed", "recorder exited before producing audio")
        );
      }

      const session: TuiVoiceSession = {
        async stop() {
          await stopRecorder(state);
          await wavSizeOrThrow(wavPath);
          try {
            const text =
              options.config.asrProvider === "glm"
                ? await transcribeWithGlm({ config: options.config, fetchImpl, wavPath })
                : await transcribeWithWhisper({
                    config: options.config,
                    runCommand:
                      options.runWhisperCommand ?? createDefaultWhisperRunner(options.config),
                    wavPath,
                  });
            return normalizeTranscript(text);
          } finally {
            await safeRemoveDirectory(directory);
          }
        },
        async cancel() {
          activeSessions.delete(session);
          try {
            await stopRecorder(state);
          } catch {
            // cancel is best-effort cleanup; its failures must not surface.
          }
          await safeRemoveDirectory(directory);
        },
      };
      activeSessions.add(session);
      return session;
    },
  };
}

function validateVoiceConfig(config: RuntimeConfig["voice"]): void {
  if (config.asrProvider === "glm" && !config.glmApiKey?.trim()) {
    throw new NodeVoiceInputError("start_failed", "glmApiKey is not set");
  }
  if (config.asrProvider === "whisper-local") {
    if (!config.whisperModelPath?.trim()) {
      throw new NodeVoiceInputError(
        "not_configured",
        "whisperModelPath is not set (voice.whisperModelPath in ~/.zcode/cli/config.json)",
      );
    }
    if (!config.whisperBin?.trim()) {
      throw new NodeVoiceInputError("not_configured", "whisperBin is not set");
    }
  }
  if (!config.soxBin?.trim()) {
    throw new NodeVoiceInputError("not_configured", "soxBin is not set");
  }
}

function spawnRecorder(
  config: RuntimeConfig["voice"],
  spawnProcess: SpawnVoiceProcess,
  wavPath: string,
): RecorderSessionState {
  const state: RecorderSessionState = {
    earlyFailure: undefined,
    exited: false,
    exitWaiters: [],
    recorder: spawnProcess(
      config.soxBin || "sox",
      [
        "-d",
        "-r",
        String(RECORD_SAMPLE_RATE_HZ),
        "-c",
        String(RECORD_CHANNELS),
        "-b",
        String(RECORD_BITS),
        wavPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    ),
    spawnStartedAt: Date.now(),
    stderrChunks: [],
    stopRequested: false,
  };

  state.recorder.stderr?.on("data", (chunk: Buffer) => {
    if (stderrLength(state.stderrChunks) < MAX_ERROR_DETAIL_CHARS) {
      state.stderrChunks.push(chunk.toString("utf8"));
    }
  });
  state.recorder.on("error", (error) => {
    state.earlyFailure = new NodeVoiceInputError("start_failed", error.message);
    markExited(state);
  });
  state.recorder.on("exit", (code, signal) => {
    if (
      state.earlyFailure === undefined &&
      !state.stopRequested &&
      Date.now() - state.spawnStartedAt < RECORD_STARTUP_PROBE_MS
    ) {
      state.earlyFailure = new NodeVoiceInputError(
        "start_failed",
        describeRecorderExit(code, signal, state.stderrChunks),
      );
    }
    markExited(state);
  });
  return state;
}

function markExited(state: RecorderSessionState): void {
  state.exited = true;
  const waiters = state.exitWaiters.splice(0, state.exitWaiters.length);
  for (const waiter of waiters) waiter();
}

function waitUntil(state: RecorderSessionState, timeoutMs: number): Promise<boolean> {
  if (state.exited) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(true);
      detachWaiter();
    }, timeoutMs);
    const waiter = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const detachWaiter = () => {
      const index = state.exitWaiters.indexOf(waiter);
      if (index >= 0) state.exitWaiters.splice(index, 1);
    };
    state.exitWaiters.push(waiter);
  });
}

async function stopRecorder(state: RecorderSessionState): Promise<void> {
  state.stopRequested = true;
  if (!state.exited) {
    state.recorder.kill("SIGINT");
    if (!(await waitUntil(state, RECORD_STOP_TIMEOUT_MS))) {
      state.recorder.kill("SIGKILL");
      await waitUntil(state, RECORD_KILL_TIMEOUT_MS);
    }
  }
  if (state.earlyFailure) throw state.earlyFailure;
}

async function createVoiceTempDirectory(env: NodeJS.ProcessEnv): Promise<string> {
  const storageRoot = env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode");
  const voiceRoot = join(storageRoot, "voice");
  await mkdir(voiceRoot, { recursive: true });
  return mkdtemp(join(voiceRoot, "rec-"));
}

async function safeRemoveDirectory(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true }).catch(() => undefined);
}

/** VAD 模型解析：显式 voice.vadModelPath 优先；否则探测 whisper 模型同目录。 */
function resolveVadModelPath(config: RuntimeConfig["voice"]): string | undefined {
  const explicit = config.vadModelPath?.trim();
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  if (!config.whisperModelPath) return undefined;
  const candidate = join(dirname(config.whisperModelPath), VAD_MODEL_FILENAME);
  return existsSync(candidate) ? candidate : undefined;
}

async function wavSizeOrThrow(wavPath: string): Promise<number> {
  const info = await stat(wavPath).catch(() => undefined);
  const bytes = info?.size ?? 0;
  if (bytes < MIN_RECORDED_BYTES) {
    throw new NodeVoiceInputError("transcribe_failed", "recording is empty or too short");
  }
  return bytes;
}

function transcribeWithWhisper(context: {
  config: RuntimeConfig["voice"];
  runCommand: RunWhisperCommand;
  wavPath: string;
}): Promise<string> {
  const { config, runCommand, wavPath } = context;
  const args = [
    "-m",
    config.whisperModelPath ?? "",
    "-l",
    config.language || "zh",
    "-t",
    String(WHISPER_THREADS),
  ];
  const vadModelPath = resolveVadModelPath(config);
  if (vadModelPath) {
    // Silero VAD 挡静音幻觉：无有效人声段时 whisper 输出为空（2026-09-27
    // 实测：静音录音无 VAD 会稳定产出「优优独播剧场」类字幕水印幻觉句）。
    args.push("--vad", "-vm", vadModelPath, "-vt", String(VAD_THRESHOLD));
    args.push("-vspd", String(VAD_MIN_SPEECH_MS));
    args.push("-vsd", String(VAD_MIN_SILENCE_MS));
    args.push("-vp", String(VAD_SPEECH_PAD_MS));
  }
  args.push("-f", wavPath, "-nt");
  return runCommand(
    config.whisperBin || "whisper-cli",
    args,
    { maxOutputChars: MAX_WHISPER_OUTPUT_CHARS, timeoutMs: TRANSCRIBE_TIMEOUT_MS },
  ).then((result) => {
    if (result.exitCode !== 0) {
      throw new NodeVoiceInputError(
        "transcribe_failed",
        truncate(
          result.stderr.trim() || `whisper exited with code ${result.exitCode}`,
          MAX_ERROR_DETAIL_CHARS,
        ),
      );
    }
    return result.stdout;
  });
}

function createDefaultWhisperRunner(config: RuntimeConfig["voice"]): RunWhisperCommand {
  return (file, args, runOptions) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stderrLength(stdoutChunks) < runOptions.maxOutputChars) {
          stdoutChunks.push(chunk.toString("utf8"));
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrLength(stderrChunks) < MAX_ERROR_DETAIL_CHARS) {
          stderrChunks.push(chunk.toString("utf8"));
        }
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new NodeVoiceInputError(
            "transcribe_failed",
            `whisper timed out after ${runOptions.timeoutMs}ms`,
          ),
        );
      }, runOptions.timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new NodeVoiceInputError("start_failed", error.message));
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        });
      });
    });
}

async function transcribeWithGlm(context: {
  config: RuntimeConfig["voice"];
  fetchImpl: VoiceFetch;
  wavPath: string;
}): Promise<string> {
  const { config, fetchImpl, wavPath } = context;
  const audio = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "recording.wav");
  form.append("model", config.glmModel || "glm-asr");
  const base = (config.glmBaseUrl || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/u, "");
  const response = await fetchImpl(`${base}/audio/transcriptions`, {
    body: form,
    headers: { Authorization: `Bearer ${config.glmApiKey ?? ""}` },
    method: "POST",
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new NodeVoiceInputError(
      "transcribe_failed",
      error instanceof Error ? error.message : String(error),
    );
  });
  if (!response.ok) {
    throw new NodeVoiceInputError("transcribe_failed", `HTTP ${response.status}`);
  }
  const data = (await response.json().catch(() => {
    throw new NodeVoiceInputError("transcribe_failed", "invalid GLM ASR response body");
  })) as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new NodeVoiceInputError("transcribe_failed", "GLM ASR response has no text field");
  }
  return data.text;
}

function describeRecorderExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrChunks: string[],
): string {
  const detail =
    stderrChunks.join("").trim() ||
    `recorder exited with code ${code ?? "null"}, signal ${signal ?? "null"}`;
  return truncate(detail, MAX_ERROR_DETAIL_CHARS);
}

function stderrLength(chunks: string[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
