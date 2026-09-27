/**
 * Paraformer 基准 provider：sherpa-onnx OfflineRecognizer + paraformer 模型。
 * 复用 SenseVoice 的帧协议 worker（sherpa 配置不同、协议一致）。
 * hotwords 是 recognizer 构造级配置：hotword 版本用独立实例（-provider
 * paraformer --hotwords <file> 时 name=paraformer-hotword）。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { SenseVoiceWorker } from "../../../../packages/desktop/src/main/asr/sensevoice-worker-provider.js";
import type { AsrBenchmarkProvider, TranscribeInput, TranscribeOutput } from "./provider.js";

export type ParaformerProviderOptions = {
  modelDir: string;
  workerModulePath: string;
  threads?: number;
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

export function createParaformerBenchmarkProvider(options: ParaformerProviderOptions): AsrBenchmarkProvider {
  const worker = new SenseVoiceWorker(
    {
      modelPath: options.modelDir.endsWith(".onnx") ? options.modelDir : `${options.modelDir}/model.int8.onnx`,
      tokensPath: options.modelDir.endsWith(".onnx")
        ? options.modelDir.replace(/model\.int8\.onnx$/u, "tokens.txt")
        : `${options.modelDir}/tokens.txt`,
      threads: options.threads ?? 4,
      useItn: true,
    },
    options.workerModulePath,
  );
  const withHotword = options.hotwordsFile !== undefined && existsSync(options.hotwordsFile);

  return {
    name: withHotword ? "paraformer-hotword" : "paraformer",
    engine: {
      name: "Paraformer-zh 2023-09-14",
      model: options.modelDir,
      quantization: "int8",
      runtime: `sherpa-onnx-node@1.13.8 (hotwords=${withHotword ? "on" : "off"}, threads=${options.threads ?? 4})`,
    },
    async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
      const startedAt = performance.now();
      const wav = await readFile(input.wavPath);
      const pcm = pcm16FromWav(wav);
      const workerResult = await worker.transcribe({ pcm16: pcm, sampleRate: 16_000 });
      const text = workerResult.text;
      const wallSeconds = (performance.now() - startedAt) / 1000;
      return {
        text,
        segments: text ? [{ start: 0, end: input.audioSeconds, text }] : [],
        inferenceSeconds: wallSeconds,
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
