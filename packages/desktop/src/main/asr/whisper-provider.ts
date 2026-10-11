/**
 * WhisperProvider：包装 desktopVoiceCore 的低级 whisper-cli 调用。
 * - 输入 PCM16 → 临时 wav → transcribeWithWhisper（Silero VAD 由配置决定）。
 * - 与改造前 IPC 层行为一致：同样参数、同样 prompt、同样静音预检。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzePcm16, encodeWav, isSilentPcm, transcribeWithWhisper } from "../desktopVoiceCore.js";
import type { DesktopVoiceConfig } from "../desktopVoiceCore.js";
import type { AsrProvider, AsrProviderHealth, AsrTranscribeOptions, AsrTranscribeResult } from "./types.js";

export function createWhisperProvider(config: DesktopVoiceConfig): AsrProvider {
  return {
    id: "whisper-local",
    async transcribe(options: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
      // 静音预检（与改造前 IPC 逻辑一致）：全零/极低电平直接判空。
      const health = analyzePcm16(options.pcm16);
      if (isSilentPcm(health)) {
        return { segments: [], text: "", inferenceSeconds: 0, wallSeconds: 0, peakRssMb: 0 };
      }

      const storageRoot = process.env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode");
      const voiceRoot = join(storageRoot, "voice");
      const directory = await mkdtemp(join(voiceRoot, "desktop-rec-"));
      const wavPath = join(directory, "recording.wav");
      try {
        await writeFile(wavPath, encodeWav(options.pcm16, Math.floor(options.sampleRate)));
        const startedAt = performance.now();
        const segments = await transcribeWithWhisper(config, wavPath, options.prompt);
        const wallSeconds = (performance.now() - startedAt) / 1000;
        return {
          segments,
          text: segments.map((segment) => segment.text).join("").trim(),
          inferenceSeconds: wallSeconds, // whisper 内部 total time 不在此层透出，先用墙钟近似
          wallSeconds,
          peakRssMb: 0,
        };
      } finally {
        await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      }
    },
    async health(): Promise<AsrProviderHealth> {
      return { ok: true };
    },
    async dispose(): Promise<void> {
      // whisper-cli 无常驻状态
    },
  };
}
