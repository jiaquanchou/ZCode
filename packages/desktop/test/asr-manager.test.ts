import assert from "node:assert/strict";
import { test } from "node:test";
import { AsrManager, AsrManagerError } from "../src/main/asr/asr-manager.js";
import type { AsrProvider, AsrProviderHealth, AsrTranscribeOptions, AsrTranscribeResult } from "../src/main/asr/types.js";

const okResult: AsrTranscribeResult = {
  segments: [{ start: 0, end: 1, text: "你好" }],
  text: "你好",
  inferenceSeconds: 0.1,
  wallSeconds: 0.1,
  peakRssMb: 100,
};

function fakeProvider(id: string, behavior: "ok" | "throw" | "silent"): AsrProvider {
  return {
    id,
    async transcribe(options: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
      if (behavior === "throw") throw new Error(`[${id}] boom`);
      if (behavior === "silent") return { segments: [], text: "", inferenceSeconds: 0, wallSeconds: 0, peakRssMb: 0 };
      return okResult;
    },
    async health(): Promise<AsrProviderHealth> {
      return { ok: true };
    },
    async dispose(): Promise<void> {},
  };
}

test("首选 provider 正常时直接返回，不触发 fallback", async () => {
  const manager = AsrManager.withProviders([fakeProvider("sensevoice", "ok")], fakeProvider("whisper-local", "ok"));
  const result = await manager.transcribe({ pcm16: new Int16Array(16000), sampleRate: 16000, provider: "sensevoice" });
  assert.equal(result.provider, "sensevoice");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.text, "你好");
  assert.equal(manager.statsSnapshot.fallbackCount, 0);
});

test("非 whisper provider 抛错时自动 fallback 到 whisper", async () => {
  const manager = AsrManager.withProviders([fakeProvider("sensevoice", "throw")], fakeProvider("whisper-local", "ok"));
  const result = await manager.transcribe({ pcm16: new Int16Array(16000), sampleRate: 16000, provider: "sensevoice" });
  assert.equal(result.provider, "whisper-local");
  assert.equal(result.fallbackUsed, true);
  assert.match(result.primaryError ?? "", /\[sensevoice\] boom/);
  assert.equal(manager.statsSnapshot.fallbackCount, 1);
});

test("静音结果（空转写）不算失败，不触发 fallback", async () => {
  const manager = AsrManager.withProviders([fakeProvider("sensevoice", "silent")], fakeProvider("whisper-local", "ok"));
  const result = await manager.transcribe({ pcm16: new Int16Array(16000), sampleRate: 16000, provider: "sensevoice" });
  assert.equal(result.provider, "sensevoice");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.text, "");
});

test("whisper 自身失败直接抛错，不无限 fallback", async () => {
  const manager = AsrManager.withProviders([fakeProvider("sensevoice", "throw")], fakeProvider("whisper-local", "throw"));
  await assert.rejects(
    manager.transcribe({ pcm16: new Int16Array(16000), sampleRate: 16000, provider: "sensevoice" }),
    AsrManagerError,
  );
  assert.equal(manager.statsSnapshot.fallbackCount, 1);
});

test("无首选 provider 时直接走 fallback", async () => {
  const manager = AsrManager.withProviders([], fakeProvider("whisper-local", "ok"));
  const result = await manager.transcribe({ pcm16: new Int16Array(16000), sampleRate: 16000 });
  assert.equal(result.provider, "whisper-local");
  assert.equal(result.fallbackUsed, true);
});

test("health 汇总包含全部 provider 与 fallback", async () => {
  const manager = AsrManager.withProviders([fakeProvider("sensevoice", "ok")], fakeProvider("whisper-local", "ok"));
  const health = await manager.health();
  assert.ok(health.sensevoice);
  assert.ok(health["whisper-local"]);
});
