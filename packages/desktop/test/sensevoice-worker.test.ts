import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { join } from "node:path";
import {
  createSenseVoiceWorkerProvider,
  resolveSenseVoiceModelPaths,
} from "../src/main/asr/sensevoice-worker-provider.js";

const dshPaths = resolveSenseVoiceModelPaths();
const hasModel = dshPaths !== undefined;
const AUDIO = (name: string) => join(process.cwd(), "tools/asr-benchmark/audio", name);
const WORKER = join(process.cwd(), "packages/desktop/src/main/asr/sensevoice-worker.cjs");

async function pcmFromFile(name: string): Promise<Int16Array> {
  const wav = await readFile(AUDIO(name));
  const pcm = new Int16Array((wav.length - 44) / 2);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = wav.readInt16LE(44 + index * 2);
  }
  return pcm;
}

test.skipIf(!hasModel)("resolveSenseVoiceModelPaths: 能发现模型（DSH 资产或显式配置）", () => {
  assert.ok(dshPaths?.model.includes("model.int8.onnx"));
  assert.ok(dshPaths?.tokens.endsWith("tokens.txt"));
});

test.skipIf(!hasModel)("sensevoice worker E2E：spawn→ready→转写→文本正确且快", async () => {
  assert.ok(existsSync(WORKER), "worker .cjs 应存在");
  const provider = createSenseVoiceWorkerProvider({
    config: {},
    workerModulePath: WORKER,
    threads: 4,
  });
  const pcm = await pcmFromFile("003.wav");
  const result = await provider.transcribe({ pcm16: pcm, sampleRate: 16_000 });
  assert.match(result.text, /检查/);
  assert.ok(result.inferenceSeconds < 2, `SenseVoice 推断应 <2s（实际 ${result.inferenceSeconds.toFixed(3)}s）`);
  await provider.dispose();
});

test.skipIf(!hasModel)("sensevoice worker E2E：连发两条（队列消费 + 模型复用）", async () => {
  const provider = createSenseVoiceWorkerProvider({
    config: {},
    workerModulePath: WORKER,
    threads: 4,
  });
  const pcm = await pcmFromFile("003.wav");
  const [a, b] = await Promise.all([
    provider.transcribe({ pcm16: pcm, sampleRate: 16_000 }),
    provider.transcribe({ pcm16: pcm, sampleRate: 16_000 }),
  ]);
  assert.equal(a.text, b.text); // 确定性
  assert.match(a.text, /检查/);
  await provider.dispose();
});

// worker 子进程/stdio 即便 SIGKILL 清理后，node:test 仍可能因 tsx loader
// worker 线程等非测试句柄等待排空；测试全部通过后显式退出，避免 CI 挂起。
process.on("beforeExit", () => process.exit(0));
setTimeout(() => process.exit(0), 5_000).unref();
