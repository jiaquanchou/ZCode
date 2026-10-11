/**
 * SenseVoiceWorkerProvider：spawn 常驻 worker（CJS + 二进制帧协议）。
 * - worker 为独立 Node 进程（ELECTRON_RUN_AS_NODE=1 下 Electron 二进制亦可），
 *   native addon 崩溃不拖死 Electron main；模型加载一次常驻。
 * - 并发=1 + 小队列（上限 2，队满丢最旧预览）；转写超时 30s。
 * - 崩溃自动重启，60s 窗口限 3 次，超限抛错由 AsrManager fallback whisper。
 * - 代次 id 防旧结果覆盖新 session。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AsrProvider, AsrProviderHealth, AsrTranscribeOptions, AsrTranscribeResult } from "./types.js";

const READY_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;
const MAX_QUEUE = 2;

export type SenseVoiceWorkerOptions = {
  modelPath: string;
  tokensPath: string;
  threads?: number;
  useItn?: boolean;
};

/** 解析模型路径：显式配置 → 本机 storage → DSH 已下载资产。 */
export function resolveSenseVoiceModelPaths(configured?: string): { model: string; tokens: string } | undefined {
  const explicit = configured?.trim();
  if (explicit) {
    const tokens = join(explicit, "tokens.txt");
    if (existsSync(explicit) && existsSync(tokens)) return { model: explicit, tokens };
    return undefined;
  }
  const candidates = [
    join(process.env.ZCODE_STORAGE_DIR?.trim() || join(process.env.HOME ?? "", ".zcode"), "asr", "sensevoice-onnx"),
    join(process.env.HOME ?? "", ".dsh", "speech-to-text", "sensevoice", "models", "sensevoice-onnx"),
  ];
  for (const dir of candidates) {
    const model = join(dir, "model.int8.onnx");
    const tokens = join(dir, "tokens.txt");
    if (existsSync(model) && existsSync(tokens)) return { model, tokens };
  }
  return undefined;
}

type Pending = {
  resolve: (result: { text: string; inferenceSeconds: number }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class SenseVoiceWorker {
  private child: ChildProcess | undefined;
  private readonly restartTimes: number[] = [];
  private ready = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: Array<{
    options: AsrTranscribeOptions;
    resolve: (result: AsrTranscribeResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private stdinBuffer = Buffer.alloc(0);
  private stdoutBuffer = Buffer.alloc(0);
  private fatalError: string | undefined;

  constructor(
    private readonly options: SenseVoiceWorkerOptions,
    private readonly workerModulePath: string,
  ) {}

  get isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.ready;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.ready = false;
    this.fatalError = undefined;
    this.stdinBuffer = Buffer.alloc(0);
    this.stdoutBuffer = Buffer.alloc(0);
    this.child = spawn(process.execPath, [this.workerModulePath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1", // Electron 二进制以纯 Node 模式跑 worker
        SENSEVOICE_MODEL: this.options.modelPath,
        SENSEVOICE_TOKENS: this.options.tokensPath,
        SENSEVOICE_THREADS: String(this.options.threads ?? 4),
        SENSEVOICE_ITN: this.options.useItn === false ? "0" : "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
      this.parseStdout();
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      // 崩溃栈等：保持最近一段用于诊断
      const text = chunk.toString("utf8");
      if (text.includes("Error") || text.includes("error")) this.fatalError = text.slice(-300);
    });
    this.child.on("exit", () => {
      this.ready = false;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("[asr:sensevoice] worker 已退出"));
      }
      this.pending.clear();
      if (this.shouldRestart()) {
        void this.start()
          .then(() => this.drain())
          .catch(() => {
            for (const item of this.queue.splice(0)) item.reject(new Error("[asr:sensevoice] 重启失败"));
          });
      } else {
        for (const item of this.queue.splice(0)) item.reject(new Error("[asr:sensevoice] worker 崩溃超限，不再重启"));
      }
    });

    // 等 ready 帧
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[asr:sensevoice] worker 启动超时${this.fatalError ? `: ${this.fatalError}` : ""}`)), READY_TIMEOUT_MS),
    );
    await Promise.race([
      (async () => {
        while (!this.ready) await new Promise((resolve) => setTimeout(resolve, 100));
      })(),
      timeout,
    ]);
  }

  private parseStdout(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.stdoutBuffer.length < 4) return;
      const frameLength = this.stdoutBuffer.readUInt32BE(0);
      if (this.stdoutBuffer.length < 4 + frameLength) return;
      const payload = this.stdoutBuffer.subarray(4, 4 + frameLength).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(4 + frameLength);
      let msg: { type: string; id?: number; text?: string; inferenceSeconds?: number; message?: string };
      try {
        msg = JSON.parse(payload);
      } catch {
        continue;
      }
      if (msg.type === "ready") {
        this.ready = true;
        continue;
      }
      if ((msg.type === "result" || msg.type === "error") && typeof msg.id === "number") {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.type === "result") {
          pending.resolve({ text: msg.text ?? "", inferenceSeconds: msg.inferenceSeconds ?? 0 });
        } else {
          pending.reject(new Error(`[asr:sensevoice] ${msg.message}`));
        }
      }
    }
  }

  private sendFrame(payload: Buffer): void {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    this.child?.stdin?.write(Buffer.concat([header, payload]));
  }

  private sendJson(obj: Record<string, unknown>): void {
    this.sendFrame(Buffer.from(JSON.stringify(obj), "utf8"));
  }

  private shouldRestart(): boolean {
    const now = Date.now();
    this.restartTimes.push(now);
    while (this.restartTimes.length > 0 && this.restartTimes[0] !== undefined && now - this.restartTimes[0] > RESTART_WINDOW_MS) {
      this.restartTimes.shift();
    }
    return this.restartTimes.length <= MAX_RESTARTS_PER_WINDOW;
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const item = this.queue[0];
      if (!item) break;
      this.queue.shift();
      this.dispatch(item.options).then(item.resolve, item.reject);
    }
  }

  private async dispatch(options: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
    if (!this.isRunning) await this.start();
    const id = this.nextId;
    this.nextId += 1;
    const pcm = Buffer.from(options.pcm16.buffer, options.pcm16.byteOffset, options.pcm16.byteLength);

    const result = await new Promise<{ text: string; inferenceSeconds: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("[asr:sensevoice] 转写超时"));
      }, TRANSCRIBE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      // 帧 A：JSON 元数据；帧 B：PCM 裸数据
      this.sendJson({ type: "transcribe", id, sampleRate: options.sampleRate, prompt: options.prompt ?? "", pcmBytes: pcm.length });
      this.sendFrame(pcm);
    });
    return { ...result, wallSeconds: result.inferenceSeconds, peakRssMb: 0 };
  }

  async transcribe(options: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
    if (this.pending.size > 0 || this.queue.length >= MAX_QUEUE) {
      const dropped = this.queue.shift();
      dropped?.reject(new Error("[asr:sensevoice] 队列已满，丢弃最旧预览"));
    }
    return new Promise<AsrTranscribeResult>((resolve, reject) => {
      this.queue.push({ options, resolve, reject });
      if (this.queue.length === 1 && this.pending.size === 0) this.drain();
    });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    if (!child || child.exitCode !== null) return;
    // worker 无状态（模型缓存随进程销毁重建）：SIGKILL 直杀，
    // 并立即销毁 stdio，避免 node:test/父进程等待句柄排空而挂起。
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    child.kill("SIGKILL");
    const timer = setTimeout(() => resolve(), 1_000);
    await exited;
    clearTimeout(timer);
  }
}

export function createSenseVoiceWorkerProvider(options: {
  config: { sensevoiceModelPath?: string };
  /** worker .cjs 绝对路径；缺省解析为本目录同级的 sensevoice-worker.cjs。 */
  workerModulePath?: string;
  threads?: number;
  useItn?: boolean;
}): AsrProvider {
  const paths = resolveSenseVoiceModelPaths(options.config.sensevoiceModelPath);
  const workerModulePath =
    options.workerModulePath ?? new URL("./sensevoice-worker.cjs", import.meta.url).pathname;
  let worker: SenseVoiceWorker | undefined;
  let initError: string | undefined;

  return {
    id: "sensevoice",
    async transcribe(transcribeOptions: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
      if (!paths) {
        throw new Error("[asr:sensevoice] 模型未找到（voice.sensevoiceModelPath 或 ~/.zcode/asr/sensevoice-onnx）");
      }
      if (!worker) {
        worker = new SenseVoiceWorker(
          { modelPath: paths.model, tokensPath: paths.tokens, threads: options.threads, useItn: options.useItn },
          workerModulePath,
        );
      }
      // 静音预检在 AsrManager 上游（analyzePcm16）；worker 只管转写。
      try {
        return await worker.transcribe(transcribeOptions);
      } catch (error) {
        initError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    async health(): Promise<AsrProviderHealth> {
      if (!paths) return { ok: false, detail: "sensevoice 模型未找到" };
      if (initError) return { ok: false, detail: initError };
      return { ok: true };
    },
    async dispose(): Promise<void> {
      await worker?.dispose();
    },
  };
}
