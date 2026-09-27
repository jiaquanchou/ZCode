import { ipcMain } from "electron";
import { readDesktopVoiceConfig } from "./desktopVoiceCore.js";
import { AsrManager } from "./asr/asr-manager.js";
import type { DesktopWhisperSegment } from "./desktopVoiceCore.js";

export const VOICE_TRANSCRIBE_CHANNEL = "voice:transcribe";

const VOICE_MAX_PCM_SAMPLES = 16_000 * 300; // 5 分钟上限
const VOICE_MIN_PCM_SAMPLES = 1_600; // <0.1s 视为误触

/**
 * AsrManager 懒加载 + 配置热更新检测：manager 按创建时配置组装 provider；
 * 当 config.asrProvider 与缓存不一致时重建（保持「改配置立即生效」的旧语义）。
 */
let asrManagerPromise: Promise<AsrManager> | undefined;
let cachedProviderId: string | undefined;

async function getAsrManager(): Promise<AsrManager> {
  const config = await readDesktopVoiceConfig();
  if (asrManagerPromise === undefined || cachedProviderId !== config.asrProvider) {
    asrManagerPromise = AsrManager.create(config);
    cachedProviderId = config.asrProvider;
  }
  return asrManagerPromise;
}

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

      const manager = await getAsrManager();
      const result = await manager.transcribe({
        pcm16,
        sampleRate,
        prompt: typeof prompt === "string" ? prompt : undefined,
      });
      return result.segments;
    },
  );
}
