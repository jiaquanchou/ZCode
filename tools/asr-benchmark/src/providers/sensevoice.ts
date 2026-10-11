/**
 * SenseVoice 基准 provider：直接复用 desktop 的 SenseVoiceWorker（spawn+帧协议）。
 * wavPath 输入 → 读 PCM → worker 转写。
 */
import { readFile } from "node:fs/promises";
import { SenseVoiceWorker } from "../../../../packages/desktop/src/main/asr/sensevoice-worker-provider.js";
import type { AsrBenchmarkProvider, TranscribeInput, TranscribeOutput } from "./provider.js";

export type SenseVoiceProviderOptions = {
  /** 模型目录（含 model.int8.onnx + tokens.txt）。 */
  modelDir: string;
  /** worker .cjs 绝对路径。 */
  workerModulePath: string;
  threads?: number;
  /** 是否启用 ITN（逆文本规范化，数字/日期转写）。 */
  useItn?: boolean;
  /** 可选热词文件（sherpa hotwords.txt 格式），SenseVoice 对热词支持有限，默认不传。 */
  hotwordsFile?: string;
  hotwordsScore?: number;
};

function pcm16FromWav(wav: Buffer): Int16Array {
  const pcm = new Int16Array((wav.length - 44) / 2);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = wav.readInt16LE(44 + index * 2);
  }
  return pcm;
}

export function createSenseVoiceBenchmarkProvider(options: SenseVoiceProviderOptions): AsrBenchmarkProvider {
  const worker = new SenseVoiceWorker(
    {
      modelPath: options.modelDir.endsWith(".onnx") ? options.modelDir : `${options.modelDir}/model.int8.onnx`,
      tokensPath: options.modelDir.endsWith(".onnx")
        ? options.modelDir.replace(/model\.int8\.onnx$/u, "tokens.txt")
        : `${options.modelDir}/tokens.txt`,
      threads: options.threads ?? 4,
      useItn: options.useItn ?? true,
    },
    options.workerModulePath,
  );

  return {
    name: "sensevoice",
    engine: {
      name: "SenseVoiceSmall",
      model: options.modelDir,
      quantization: "int8",
      runtime: `sherpa-onnx-node@1.13.8 (itn=${options.useItn ?? true ? "on" : "off"}, threads=${options.threads ?? 4})`,
    },
    async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
      const startedAt = performance.now();
      const wav = await readFile(input.wavPath);
      const pcm = pcm16FromWav(wav);
      const workerResult = await worker.transcribe({ pcm16: pcm, sampleRate: 16_000, prompt: input.prompt });
      const text = workerResult.text;
      const wallSeconds = (performance.now() - startedAt) / 1000;
      return {
        text,
        segments: text ? [{ start: 0, end: input.audioSeconds, text }] : [],
        inferenceSeconds: wallSeconds, // worker 回传的 inferenceSeconds 更精确，但这里统一墙钟口径
        wallSeconds,
        rssMb: 0,
        peakRssMb: 0,
        loadSeconds: 0,
      };
    },
    async dispose(): Promise<void> {
      await worker.dispose();
    },
  };
}
