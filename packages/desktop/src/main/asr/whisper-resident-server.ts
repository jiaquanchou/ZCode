/**
 * WhisperResidentServer：whisper-server 常驻子进程管理器。
 * - 独立子进程承载 whisper.cpp 模型（模型加载一次，之后零 page-in）
 * - ready 探测：轮询 HTTP 直到服务可用
 * - 崩溃自动重启，限流 60s 内最多 3 次；超限后不再重启（由 AsrManager 走 fallback）
 * - dispose 时温和退出（SIGTERM → 超时 SIGKILL）
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 30_000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;
const INFERENCE_TIMEOUT_MS = 120_000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BASE_PORT = 18_281;

export type WhisperResidentServerOptions = {
  bin: string;
  modelPath: string;
  vadModelPath?: string;
  language?: string;
  threads?: number;
  host?: string;
  basePort?: number;
};

export class WhisperResidentServer {
  private child: ChildProcess | undefined;
  private readonly restartTimes: number[] = [];
  private port = 0;
  private host = DEFAULT_HOST;

  constructor(private readonly options: WhisperResidentServerOptions) {}

  get isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** 当前服务地址（ready 后有效）。 */
  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** 启动（若已在跑则忽略）；返回 ready 的 baseUrl 或抛错。 */
  async start(): Promise<string> {
    if (this.isRunning) return this.baseUrl;
    this.port = await this.pickPort();
    this.host = this.options.host ?? DEFAULT_HOST;

    const args = [
      "-m",
      this.options.modelPath,
      "-l",
      this.options.language ?? "zh",
      "-t",
      String(this.options.threads ?? 8),
      "--host",
      this.host,
      "--port",
      String(this.port),
    ];
    if (this.options.vadModelPath) {
      args.push("--vad", "-vm", this.options.vadModelPath);
      args.push("-vt", "0.45", "-vspd", "180", "-vsd", "350", "-vp", "200");
    }
    this.child = spawn(this.options.bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.child.stderr?.on("data", () => {
      // whisper-server 把 Metal/timings 打到 stderr，这里仅做进程存活性兜底，
      // 不吞日志：开发期可以 tail 该流查问题。
    });
    this.child.on("exit", () => {
      void this.maybeRestart();
    });

    await this.waitUntilReady();
    return this.baseUrl;
  }

  /** 等 HTTP 就绪（轮询 /inference，出现任意响应即视为就绪）。 */
  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.isRunning) throw new Error("[asr] whisper-server 启动即退出");
      try {
        await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(2_000) });
        return;
      } catch {
        // 未就绪，继续轮询
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error(`[asr] whisper-server 启动超时（${READY_TIMEOUT_MS}ms）`);
  }

  /** 调一次转写（multipart wav → text）。失败抛错由调用方处理（fallback）。 */
  async transcribeWav(wavBuffer: Buffer, prompt?: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "recording.wav");
    const headers: Record<string, string> = {};
    if (prompt?.trim()) headers["X-Prompt"] = prompt.trim();
    const response = await fetch(`${this.baseUrl}/inference`, {
      method: "POST",
      body: form,
      headers,
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`[asr] whisper-server HTTP ${response.status}`);
    const data = (await response.json()) as { text?: unknown };
    if (typeof data.text !== "string") throw new Error("[asr] whisper-server 响应缺少 text");
    return data.text;
  }

  /**
   * 崩溃重启，带限流：60s 窗口内最多 3 次，超限停止（交由 AsrManager fallback）。
   * 重启后非同步等待 ready（避免阻塞转写路径），由后续请求自然触发重试/fallback。
   */
  private maybeRestart(): void {
    if (!this.shouldRestart()) return;
    void this.start().catch(() => {
      // 重启失败：保持停止，fallback 路径接管
    });
  }

  private shouldRestart(): boolean {
    const now = Date.now();
    this.restartTimes.push(now);
    while (this.restartTimes.length > 0 && this.restartTimes[0] !== undefined && now - this.restartTimes[0] > RESTART_WINDOW_MS) {
      this.restartTimes.shift();
    }
    return this.restartTimes.length <= MAX_RESTARTS_PER_WINDOW;
  }

  private async pickPort(): Promise<number> {
    const base = this.options.basePort ?? DEFAULT_BASE_PORT;
    for (let offset = 0; offset < 8; offset += 1) {
      const candidate = base + offset;
      if (await this.portFree(candidate)) return candidate;
    }
    throw new Error("[asr] 找不到可用端口（18281-18288 均被占用）");
  }

  private async portFree(port: number): Promise<boolean> {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      return false; // 有响应 = 被占用
    } catch {
      return true; // 连接失败 = 空闲（或服务未起）
    }
  }

  /** 温和退出；等 2s 未退则 SIGKILL。 */
  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit") as Promise<unknown>;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(timer);
  }
}
