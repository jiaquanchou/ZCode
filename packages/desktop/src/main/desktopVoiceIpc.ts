import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcMain } from "electron";
import {
  analyzePcm16,
  createVoiceTempDirectory,
  encodeWav,
  isSilentPcm,
  readDesktopVoiceConfig,
  transcribeWithGlm,
  transcribeWithWhisper,
  VOICE_MAX_PCM_SAMPLES,
  VOICE_MIN_PCM_SAMPLES,
  VOICE_TRANSCRIBE_CHANNEL,
  type DesktopWhisperSegment,
} from "./desktopVoiceCore.js";

export function registerDesktopVoiceIpc(): void {
  ipcMain.handle(
    VOICE_TRANSCRIBE_CHANNEL,
    async (
      _event,
      pcm16: unknown,
      sampleRate: unknown,
      prompt: unknown,
    ): Promise<DesktopWhisperSegment[]> => {
      if (!(pcm16 instanceof Int16Array) || typeof sampleRate !== "number") {
        throw new Error("[voice] invalid transcribe payload");
      }
      if (pcm16.length > VOICE_MAX_PCM_SAMPLES) {
        throw new Error("[voice] recording too long (max 5 minutes)");
      }
      if (pcm16.length < VOICE_MIN_PCM_SAMPLES) return [];
      const health = analyzePcm16(pcm16);
      if (isSilentPcm(health)) {
        // 采集层就没拿到声音（错误设备/坏麦克风），不值得进任何 ASR。
        console.info(
          `[voice] silent capture rejected: rms=${health.rms.toExponential(2)} peak=${health.peak.toExponential(2)} zeroRatio=${health.zeroRatio.toFixed(4)}`,
        );
        return [];
      }
      const config = await readDesktopVoiceConfig();
      if (config.asrProvider === "glm" && !config.glmApiKey) {
        throw new Error("[voice] voice.glmApiKey is not set (~/.zcode/cli/config.json)");
      }
      if (config.asrProvider === "whisper-local" && !config.whisperModelPath) {
        throw new Error("[voice] voice.whisperModelPath is not set (~/.zcode/cli/config.json)");
      }
      const directory = await createVoiceTempDirectory(process.env);
      const wavPath = join(directory, "recording.wav");
      try {
        await writeFile(wavPath, encodeWav(pcm16, Math.floor(sampleRate)));
        const durationSeconds = pcm16.length / Math.floor(sampleRate);
        const promptText = typeof prompt === "string" ? prompt : undefined;
        const segments =
          config.asrProvider === "glm"
            ? await transcribeWithGlm(config, wavPath, durationSeconds)
            : await transcribeWithWhisper(config, wavPath, promptText);
        return segments;
      } finally {
        await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      }
    },
  );
}
