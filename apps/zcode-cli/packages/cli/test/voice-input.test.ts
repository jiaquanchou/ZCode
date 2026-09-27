import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createNodeVoiceInput, NodeVoiceInputError, type VoiceFetch } from "../src/voice-input.js";
import type { RuntimeConfig } from "@zcode/contracts";

const sandboxRoot = await mkdtemp(join(tmpdir(), "zcode-voice-test-"));
after(async () => {
  await rm(sandboxRoot, { force: true, recursive: true });
});

type FakeRecorder = {
  killSignals: string[];
  listeners: Map<string, Array<(code: number | null, signal: NodeJS.Signals | null) => void>>;
  stderr: null;
  wavPath: string;
  wavBytes: number;
  rapidExit: boolean;
};

function makeSpawnProcess(options: { rapidExit?: boolean; wavBytes?: number } = {}) {
  const recorders: FakeRecorder[] = [];
  const spawnProcess = (
    _file: string,
    args: string[],
    _stdio: { stdio: ["ignore", "ignore", "pipe"] },
  ) => {
    const wavPath = args[args.length - 1] ?? "";
    const recorder: FakeRecorder = {
      killSignals: [],
      listeners: new Map(),
      stderr: null,
      wavPath,
      wavBytes: options.wavBytes ?? 2048,
      rapidExit: options.rapidExit ?? false,
    };
    recorders.push(recorder);
    const processLike = {
      kill: (signal?: NodeJS.Signals) => {
        recorder.killSignals.push(signal ?? "SIGTERM");
        setTimeout(() => emitExit(recorder, 0, signal ?? "SIGINT"), 10);
      },
      on: (
        event: "error" | "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
      ) => {
        const list = recorder.listeners.get(event) ?? [];
        list.push(listener);
        recorder.listeners.set(event, list);
      },
      stderr: null,
    };
    if (recorder.rapidExit) {
      setTimeout(() => emitExit(recorder, 1, null), 10);
    } else {
      // 录音“进行中”：spawn 时落一个假 wav 模拟 sox 输出。
      void writeFile(recorder.wavPath, Buffer.alloc(recorder.wavBytes)).catch(() => undefined);
    }
    return processLike;
  };
  return { recorders, spawnProcess };
}

function emitExit(
  recorder: FakeRecorder,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  for (const listener of recorder.listeners.get("exit") ?? []) listener(code, signal);
}

const baseConfig: RuntimeConfig["voice"] = {
  asrProvider: "whisper-local",
  glmBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  glmModel: "glm-asr",
  language: "zh",
  soxBin: "sox",
  whisperBin: "whisper-cli",
  whisperModelPath: "/models/ggml-test.bin",
};

const env = { ZCODE_STORAGE_DIR: sandboxRoot };

test("whisper happy path：stop 返回归一化转写文本", async () => {
  const { spawnProcess } = makeSpawnProcess();
  const voice = createNodeVoiceInput({
    config: baseConfig,
    env,
    runWhisperCommand: async () => ({
      exitCode: 0,
      signal: null,
      stdout: "帮我 看一下\n这个项目 的结构\n",
      stderr: "",
    }),
    spawnProcess,
  });
  const session = await voice.beginSession();
  const text = await session.stop();
  assert.equal(text, "帮我 看一下 这个项目 的结构");
});

test("未配置 whisperModelPath → not_configured", async () => {
  const voice = createNodeVoiceInput({
    config: { ...baseConfig, whisperModelPath: undefined },
    env,
    spawnProcess: makeSpawnProcess().spawnProcess,
  });
  await assert.rejects(voice.beginSession(), (error: unknown) => {
    assert.ok(error instanceof NodeVoiceInputError);
    assert.equal(error.code, "not_configured");
    return true;
  });
});

test("glm 缺 apiKey → start_failed", async () => {
  const voice = createNodeVoiceInput({
    config: { ...baseConfig, asrProvider: "glm", glmApiKey: undefined },
    env,
    spawnProcess: makeSpawnProcess().spawnProcess,
  });
  await assert.rejects(voice.beginSession(), (error: unknown) => {
    assert.ok(error instanceof NodeVoiceInputError);
    assert.equal(error.code, "start_failed");
    return true;
  });
});

test("glm happy path：fetch 返回 text", async () => {
  const { spawnProcess } = makeSpawnProcess();
  const fetchCalls: string[] = [];
  const fetchImpl: VoiceFetch = async (input) => {
    fetchCalls.push(input);
    return new Response(JSON.stringify({ text: " 帮我看看 这个仓库 " }), { status: 200 });
  };
  const voice = createNodeVoiceInput({
    config: { ...baseConfig, asrProvider: "glm", glmApiKey: "test-key" },
    env,
    fetchImpl,
    spawnProcess,
  });
  const session = await voice.beginSession();
  const text = await session.stop();
  assert.equal(text, "帮我看看 这个仓库");
  assert.match(fetchCalls[0] ?? "", /\/audio\/transcriptions$/u);
});

test("glm HTTP 500 → transcribe_failed", async () => {
  const { spawnProcess } = makeSpawnProcess();
  const voice = createNodeVoiceInput({
    config: { ...baseConfig, asrProvider: "glm", glmApiKey: "test-key" },
    env,
    fetchImpl: async () => new Response("boom", { status: 500 }),
    spawnProcess,
  });
  const session = await voice.beginSession();
  await assert.rejects(session.stop(), (error: unknown) => {
    assert.ok(error instanceof NodeVoiceInputError);
    assert.equal(error.code, "transcribe_failed");
    return true;
  });
});

test("录音器启动即退出 → beginSession 抛 start_failed", async () => {
  const { spawnProcess } = makeSpawnProcess({ rapidExit: true });
  const voice = createNodeVoiceInput({ config: baseConfig, env, spawnProcess });
  await assert.rejects(voice.beginSession(), (error: unknown) => {
    assert.ok(error instanceof NodeVoiceInputError);
    assert.equal(error.code, "start_failed");
    return true;
  });
});

test("录音文件过小 → transcribe_failed（empty or too short）", async () => {
  const { spawnProcess } = makeSpawnProcess({ wavBytes: 100 });
  const voice = createNodeVoiceInput({
    config: baseConfig,
    env,
    runWhisperCommand: async () => ({ exitCode: 0, signal: null, stdout: "x", stderr: "" }),
    spawnProcess,
  });
  const session = await voice.beginSession();
  await assert.rejects(session.stop(), (error: unknown) => {
    assert.ok(error instanceof NodeVoiceInputError);
    assert.equal(error.code, "transcribe_failed");
    assert.match(error.message, /empty or too short/u);
    return true;
  });
});

test("whisper 非零退出 → transcribe_failed 且带 stderr 摘要", async () => {
  const { spawnProcess } = makeSpawnProcess();
  const voice = createNodeVoiceInput({
    config: baseConfig,
    env,
    runWhisperCommand: async () => ({
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "model not found",
    }),
    spawnProcess,
  });
  const session = await voice.beginSession();
  await assert.rejects(session.stop(), (error: unknown) => {
    assert.ok(error instanceof NodeVoiceInputError);
    assert.equal(error.code, "transcribe_failed");
    assert.match(error.message, /model not found/u);
    return true;
  });
});

test("cancel：SIGINT 停止录音且清理临时目录", async () => {
  const { recorders, spawnProcess } = makeSpawnProcess();
  const voice = createNodeVoiceInput({
    config: baseConfig,
    env,
    runWhisperCommand: async () => ({ exitCode: 0, signal: null, stdout: "x", stderr: "" }),
    spawnProcess,
  });
  const session = await voice.beginSession();
  const wavPath = recorders[0]?.wavPath ?? "";
  await stat(wavPath);
  await session.cancel();
  assert.equal(recorders[0]?.killSignals[0], "SIGINT");
  await assert.rejects(stat(wavPath));
  // cancel 幂等：二次 cancel 不抛错。
  await session.cancel();
});
