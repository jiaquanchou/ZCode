import assert from "node:assert/strict";
import { existsSync, readFile } from "node:fs";
import { test } from "vitest";
import { WhisperResidentServer } from "../src/main/asr/whisper-resident-server.js";
import { createWhisperResidentProvider } from "../src/main/asr/whisper-resident-provider.js";

const MODEL = "/Users/enhanced/opt/scratch/zcode-voice/models/ggml-large-v3-turbo-q5_0.bin";
const VAD = "/Users/enhanced/opt/scratch/zcode-voice/models/ggml-silero-v6.2.0.bin";
const SAMPLE = "/Users/enhanced/code/opensource/ZCode/tools/asr-benchmark/audio/003.wav";
const hasAssets = existsSync(MODEL) && existsSync(SAMPLE) && existsSync(VAD);

const config = {
  asrProvider: "whisper-local" as const,
  glmBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  glmModel: "glm-asr",
  language: "zh",
  whisperBin: "whisper-cli",
  whisperModelPath: MODEL,
  vadModelPath: VAD,
  whisperServerBin: "whisper-server",
};

test.skipIf(!hasAssets)("resident server：启动 → 两次转写都快速（模型常驻）→ dispose", async () => {
  const server = new WhisperResidentServer({
    bin: "whisper-server",
    modelPath: MODEL,
    vadModelPath: VAD,
    language: "zh",
    threads: 8,
    basePort: 18_291,
  });
  const baseUrl = await server.start();
  assert.ok(baseUrl.startsWith("http://127.0.0.1:"));

  const wav = await readFile(SAMPLE);
  const first = performance.now();
  const text1 = await server.transcribeWav(wav);
  const firstMs = performance.now() - first;
  const second = performance.now();
  const text2 = await server.transcribeWav(wav);
  const secondMs = performance.now() - second;

  // 模型常驻：两次都应是 warm（远小于冷启动的模型加载耗时）
  assert.ok(firstMs < 3000, `首转写应 warm（实际 ${firstMs.toFixed(0)}ms）`);
  assert.ok(secondMs < 3000, `二次转写应 warm（实际 ${secondMs.toFixed(0)}ms）`);
  assert.match(text1, /检查/);
  assert.equal(text1, text2); // 同音频同参数 → 确定性

  await server.dispose();
});

test.skipIf(!hasAssets)("resident provider：静音 PCM 直接判空，不打扰常驻服务", async () => {
  const provider = createWhisperResidentProvider({ config, basePort: 18_292 });
  const result = await provider.transcribe({
    pcm16: new Int16Array(16_000).fill(0), // 1s 全零
    sampleRate: 16_000,
  });
  assert.equal(result.text, "");
  assert.equal(result.segments.length, 0);
  await provider.dispose();
});

test.skipIf(!hasAssets)("resident provider：真实音频转写返回文本并带 prompt", async () => {
  const provider = createWhisperResidentProvider({ config, basePort: 18_293 });
  const wav = await readFile(SAMPLE);
  // 从 wav 提取 PCM16（44 字节头后）
  const pcm = new Int16Array((wav.length - 44) / 2);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = wav.readInt16LE(44 + index * 2);
  }
  const result = await provider.transcribe({ pcm16: pcm, sampleRate: 16_000, prompt: "Go、数据库。" });
  assert.match(result.text, /检查/);
  assert.ok(result.segments.length > 0);
  assert.ok(result.wallSeconds > 0);
  await provider.dispose();
});
