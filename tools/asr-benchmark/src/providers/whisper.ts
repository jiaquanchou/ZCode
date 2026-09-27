/**
 * Whisper 基准 provider：spawn whisper-cli（whisper.cpp）。
 * - 输出段级时间戳文本，与生产链路（desktopVoiceCore）同参数族
 *   （-l zh -t 8，VAD 可开关）。
 * - 纯推断时间从 whisper stderr 的 `total time = X ms` 解析。
 * - macOS 用 `/usr/bin/time -l` 包装测峰值 RSS；其他平台 RSS 记 0。
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { AsrBenchmarkProvider, TranscribeInput, TranscribeOutput } from "./provider.js";

const WHISPER_SEGMENT_LINE =
  /^\s*\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/u;
const TOTAL_TIME_LINE = /\btotal time\s*=\s*([\d.]+)\s*ms/u;
const MACOS_RSS_LINE = /^\s*(\d+)\s+maximum resident set size\s*$/mu;

export type WhisperProviderOptions = {
  /** whisper-cli 二进制路径。 */
  bin: string;
  /** ggml 模型路径。 */
  modelPath: string;
  /** Silero VAD 模型路径；缺省不启用 VAD。 */
  vadModelPath?: string;
  /** 语言。 */
  language?: string;
  /** 线程数。 */
  threads?: number;
  /** 是否输出段级时间戳行（false 则用纯文本，影响 text 组装）。 */
  segmentTimestamps?: boolean;
};

const MACOS_TIME = "/usr/bin/time";

function parseSegments(stdout: string): Array<{ start: number; end: number; text: string }> {
  const segments: Array<{ start: number; end: number; text: string }> = [];
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

/** 组装 whisper 参数。VAD 参数与生产链路一致（vt0.45/vspd180/vsd350/vp200）。 */
export function buildWhisperCliArgs(options: {
  modelPath: string;
  wavPath: string;
  vadModelPath?: string;
  language?: string;
  threads?: number;
  segmentTimestamps?: boolean;
}): string[] {
  const args = ["-m", options.modelPath, "-l", options.language ?? "zh", "-t", String(options.threads ?? 8)];
  if (options.vadModelPath) {
    args.push("--vad", "-vm", options.vadModelPath);
    args.push("-vt", "0.45", "-vspd", "180", "-vsd", "350", "-vp", "200");
  }
  if (!options.segmentTimestamps) args.push("-nt");
  args.push("-f", options.wavPath);
  return args;
}

export function createWhisperProvider(options: WhisperProviderOptions): AsrBenchmarkProvider {
  const useMacOsTime = platform() === "darwin";
  return {
    name: "whisper",
    engine: {
      name: "whisper.cpp",
      model: options.modelPath,
      runtime: "whisper-cli (Metal)",
    },
    async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
      // macOS 用 time -l 包一层（rss 从 stderr 解析）；time 会把 whisper 的
      // stdout 透传、stderr 统计追加到 stderr 末尾。
      const whisperArgs = buildWhisperCliArgs({
        modelPath: options.modelPath,
        wavPath: input.wavPath,
        vadModelPath: options.vadModelPath,
        language: options.language,
        threads: options.threads,
        segmentTimestamps: options.segmentTimestamps ?? true,
      });
      const command = useMacOsTime ? MACOS_TIME : options.bin;
      const args = useMacOsTime ? ["-l", options.bin, ...whisperArgs] : whisperArgs;

      const startedAt = performance.now(); // 端到端墙钟（含 spawn/模型加载）
      let stdout = "";
      let stderr = "";
      const result = await new Promise<{ stdout: string; stderr: string; loadSeconds: number; inferenceSeconds: number }>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdoutChars = 0;
        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutChars += chunk.length;
          if (stdoutChars <= 4_000_000) stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
          if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000); // 防膨胀
        });
        child.on("error", (error) => reject(new Error(`whisper spawn 失败: ${error.message}`)));
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("whisper 转写超时（120s）"));
        }, 120_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`whisper 退出码 ${code}: ${stderr.slice(-300)}`));
            return;
          }
          // 解析 load time（第一次运行的模型加载）
          const loadMatch = /load time\s*=\s*([\d.]+)\s*ms/u.exec(stderr);
          const totalMatch = TOTAL_TIME_LINE.exec(stderr);
          resolve({
            stdout,
            stderr,
            loadSeconds: loadMatch ? Number(loadMatch[1]) / 1000 : 0,
            inferenceSeconds: totalMatch ? Number(totalMatch[1]) / 1000 : 0,
          });
        });
      });

      const wallSeconds = (performance.now() - startedAt) / 1000;
      const segments = parseSegments(result.stdout);
      // 无段时间戳（-nt）时整段兜底
      const text = segments.length > 0 ? segments.map((s) => s.text).join("").trim() : result.stdout.trim();

      // RSS：macOS time -l 输出 maximum resident set size
      let peakRssMb = 0;
      if (useMacOsTime) {
        const rssMatch = MACOS_RSS_LINE.exec(result.stderr);
        if (rssMatch) peakRssMb = Number(rssMatch[1]) / (1024 * 1024);
      }

      return {
        text,
        segments,
        inferenceSeconds: result.inferenceSeconds,
        wallSeconds,
        rssMb: peakRssMb,
        peakRssMb,
        loadSeconds: result.loadSeconds,
      };
    },
  };
}
