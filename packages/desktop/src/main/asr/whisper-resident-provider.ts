/**
 * WhisperResidentProvider：以常驻 whisper-server 为后端的 AsrProvider。
 * - 模型只加载一次（whisper-server 进程内），每次转写只是 HTTP 请求
 * - 服务器不可用/转写失败时抛错 → AsrManager 自动 fallback 到 spawn whisper
 */
import { encodeWav, analyzePcm16, isSilentPcm } from "../desktopVoiceCore.js";
import type { DesktopVoiceConfig } from "../desktopVoiceCore.js";
import { WhisperResidentServer } from "./whisper-resident-server.js";
import type { AsrProvider, AsrProviderHealth, AsrTranscribeOptions, AsrTranscribeResult } from "./types.js";

export type WhisperResidentProviderOptions = {
  config: DesktopVoiceConfig;
  bin?: string;
  basePort?: number;
};

export function createWhisperResidentProvider(options: WhisperResidentProviderOptions): AsrProvider {
  const server = new WhisperResidentServer({
    bin: options.bin ?? "whisper-server",
    modelPath: options.config.whisperModelPath ?? "",
    vadModelPath: options.config.vadModelPath,
    language: options.config.language,
    threads: 8,
    basePort: options.basePort,
  });
  let startError: string | undefined;

  return {
    id: "whisper-resident",
    async transcribe(options: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
      // 静音预检：全零/极低电平直接判空，不打扰常驻服务
      const health = analyzePcm16(options.pcm16);
      if (isSilentPcm(health)) {
        return { segments: [], text: "", inferenceSeconds: 0, wallSeconds: 0, peakRssMb: 0 };
      }
      if (!server.isRunning) {
        // 首次使用/崩溃重启后：尝试启动（限流在 server 内）。启动失败给 startError，
        // 让 AsrManager 走 fallback。
        try {
          await server.start();
          startError = undefined;
        } catch (error) {
          startError = error instanceof Error ? error.message : String(error);
          throw new Error(`[asr:whisper-resident] 启动失败: ${startError}`);
        }
      }
      const wavBuffer = encodeWav(options.pcm16, Math.floor(options.sampleRate));
      const startedAt = performance.now();
      const text = await server.transcribeWav(wavBuffer, options.prompt);
      const wallSeconds = (performance.now() - startedAt) / 1000;
      return {
        segments: text.trim() ? [{ start: 0, end: options.pcm16.length / Math.floor(options.sampleRate), text: text.trim() }] : [],
        text: text.trim(),
        inferenceSeconds: wallSeconds,
        wallSeconds,
        peakRssMb: 0,
      };
    },
    async health(): Promise<AsrProviderHealth> {
      if (startError) return { ok: false, detail: startError };
      if (server.isRunning) return { ok: true };
      // 未启动不代表不可用（首次使用才启动）；返回 ok 但标注未启动
      return { ok: true, detail: "not-started" };
    },
    async dispose(): Promise<void> {
      await server.dispose();
    },
  };
}
