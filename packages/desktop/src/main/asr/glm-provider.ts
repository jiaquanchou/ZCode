/**
 * GlmProvider：云端 GLM ASR（OpenAI 兼容 /audio/transcriptions）。
 * - 与改造前 IPC 层行为一致：写 wav → fetch → 单段（覆盖全时长）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeWav, transcribeWithGlm, analyzePcm16, isSilentPcm } from "../desktopVoiceCore.js";
import type { DesktopVoiceConfig } from "../desktopVoiceCore.js";
import type { AsrProvider, AsrProviderHealth, AsrTranscribeOptions, AsrTranscribeResult } from "./types.js";

export function createGlmProvider(config: DesktopVoiceConfig): AsrProvider {
  return {
    id: "glm",
    async transcribe(options: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
      // 静音预检（与改造前 IPC 逻辑一致）：全零/极低电平直接判空，不花云端调用。
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
        const durationSeconds = options.pcm16.length / Math.floor(options.sampleRate);
        const startedAt = performance.now();
        const segments = await transcribeWithGlm(config, wavPath, durationSeconds);
        const wallSeconds = (performance.now() - startedAt) / 1000;
        return {
          segments,
          text: segments.map((segment) => segment.text).join("").trim(),
          inferenceSeconds: wallSeconds,
          wallSeconds,
          peakRssMb: 0,
        };
      } finally {
        await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      }
    },
    async health(): Promise<AsrProviderHealth> {
      if (!config.glmApiKey?.trim()) return { ok: false, detail: "glmApiKey is not set" };
      return { ok: true };
    },
    async dispose(): Promise<void> {},
  };
}
