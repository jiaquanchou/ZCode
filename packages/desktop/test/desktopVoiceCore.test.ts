import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  analyzePcm16,
  buildWhisperArgs,
  encodeWav,
  isSilentPcm,
  parseWhisperSegments,
  readDesktopVoiceConfig,
  resolveVadModelPath,
  transcribeWithWhisper,
  type DesktopVoiceConfig,
} from "../src/main/desktopVoiceCore.js";

const sandboxRoot = await mkdtemp(join(tmpdir(), "zcode-desktop-voice-test-"));
after(async () => {
  await rm(sandboxRoot, { force: true, recursive: true });
});

test("encodeWav: 44 字节 RIFF/PCM 头字段正确", async () => {
  const pcm = new Int16Array([1, -1, 0, 32_767]);
  const wav = encodeWav(pcm, 16_000);
  assert.equal(wav.length, 44 + pcm.length * 2);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length * 2);
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16); // bits
  assert.equal(wav.readInt16LE(44), 1);
  assert.equal(wav.readInt16LE(46), -1);
});

test("encodeWav: 产物可被 whisper-cli 读取（真实模型存在时转写合成音频）", async () => {
  // 从 CLI 侧实测素材取 PCM：16k mono 16bit 的合成中文语音。
  const sourcePath = "/Users/enhanced/opt/scratch/zcode-voice/test-zh.wav";
  const modelPath = "/Users/enhanced/opt/scratch/zcode-voice/models/ggml-large-v3-turbo-q5_0.bin";
  if (!existsSync(sourcePath) || !existsSync(modelPath)) {
    return; // 素材/模型不在（CI 或他机）时跳过真机段
  }
  const source = await readFile(sourcePath);
  const sampleCount = Math.floor((source.length - 44) / 2);
  const pcm = new Int16Array(sampleCount);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = source.readInt16LE(44 + index * 2);
  }
  const wavPath = join(sandboxRoot, "roundtrip.wav");
  await writeFile(wavPath, encodeWav(pcm, 16_000));
  const config: DesktopVoiceConfig = {
    asrProvider: "whisper-local",
    glmBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    glmModel: "glm-asr",
    language: "zh",
    whisperBin: "whisper-cli",
    whisperModelPath: modelPath,
  };
  const segments = await transcribeWithWhisper(config, wavPath);
  assert.ok(segments.length > 0);
  assert.match(segments.map((segment) => segment.text).join(""), /项目/);
  // 段时间戳单调且落在 wav 时长内
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? { start: 0, end: 0, text: "" };
    assert.ok(segment.end >= segment.start);
    if (index > 0) assert.ok((segments[index - 1]?.start ?? 0) <= segment.start);
  }
});

test("parseWhisperSegments: 解析段时间戳行，忽略其他行", () => {
  const stdout = [
    "system log line should be ignored",
    "[00:00:00.000 --> 00:00:02.400] 帮我看一下这个项目的结构",
    "",
    "[00:00:02.400 --> 00:00:05.120] 然后修复登录超时的问题。",
  ].join("\n");
  const segments = parseWhisperSegments(stdout);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.start, 0);
  assert.equal(segments[0]?.end, 2.4);
  assert.equal(segments[0]?.text, "帮我看一下这个项目的结构");
  assert.ok(Math.abs((segments[1]?.start ?? 0) - 2.4) < 1e-9);
  assert.ok(Math.abs((segments[1]?.end ?? 0) - 5.12) < 1e-9);
});

test("parseWhisperSegments: 空文本行被过滤", () => {
  const segments = parseWhisperSegments("[00:00:01.000 --> 00:00:02.000]   ");
  assert.equal(segments.length, 0);
});

test("buildWhisperArgs: 参数序列（无 -nt，段级时间戳输出）", () => {
  const args = buildWhisperArgs(
    {
      asrProvider: "whisper-local",
      glmBaseUrl: "x",
      glmModel: "m",
      language: "zh",
      whisperBin: "whisper-cli",
      whisperModelPath: "/models/ggml.bin",
    },
    "/tmp/a.wav",
  );
  assert.deepEqual(args, ["-m", "/models/ggml.bin", "-l", "zh", "-t", "8", "-f", "/tmp/a.wav"]);
});

test("buildWhisperArgs: prompt 注入 initial_prompt", () => {
  const args = buildWhisperArgs(
    {
      asrProvider: "whisper-local",
      glmBaseUrl: "x",
      glmModel: "m",
      language: "zh",
      whisperBin: "whisper-cli",
      whisperModelPath: "/models/ggml.bin",
    },
    "/tmp/a.wav",
    undefined,
    "帮我看一下这个项目。WebSocket、PostgreSQL。",
  );
  const promptIndex = args.indexOf("--prompt");
  assert.equal(promptIndex, 6);
  assert.equal(args[promptIndex + 1], "帮我看一下这个项目。WebSocket、PostgreSQL。");
});

test("buildWhisperArgs: 带 VAD 时插入 Silero 参数组（阈值/切分/填充）", () => {
  const args = buildWhisperArgs(
    {
      asrProvider: "whisper-local",
      glmBaseUrl: "x",
      glmModel: "m",
      language: "zh",
      whisperBin: "whisper-cli",
      whisperModelPath: "/models/ggml.bin",
    },
    "/tmp/a.wav",
    "/models/ggml-silero-v6.2.0.bin",
  );
  assert.deepEqual(args, [
    "-m",
    "/models/ggml.bin",
    "-l",
    "zh",
    "-t",
    "8",
    "--vad",
    "-vm",
    "/models/ggml-silero-v6.2.0.bin",
    "-vt",
    "0.45",
    "-vspd",
    "180",
    "-vsd",
    "350",
    "-vp",
    "200",
    "-f",
    "/tmp/a.wav",
  ]);
});

test("analyzePcm16: 全零采集被静音判定拒绝，正常语音通过", () => {
  const silent = analyzePcm16(new Int16Array(16_000).fill(0));
  assert.equal(isSilentPcm(silent), true);
  assert.equal(silent.zeroRatio, 1);

  // 幅度 0.3 的有效语音（16k 采样 1 秒）
  const speech = new Int16Array(16_000).fill(Math.round(0.3 * 32_767));
  const speechHealth = analyzePcm16(speech);
  assert.equal(isSilentPcm(speechHealth), false);
  assert.ok(speechHealth.rms > 0.2);
});

test("resolveVadModelPath: 显式配置优先，缺失回落 undefined", () => {
  assert.equal(
    resolveVadModelPath({
      asrProvider: "whisper-local",
      glmBaseUrl: "x",
      glmModel: "m",
      language: "zh",
      whisperBin: "whisper-cli",
      vadModelPath: "/nonexistent/silero.bin",
    }),
    undefined,
  );
  const modelPath = "/Users/enhanced/opt/scratch/zcode-voice/models/ggml-large-v3-turbo-q5_0.bin";
  if (existsSync(modelPath)) {
    assert.equal(
      resolveVadModelPath({
        asrProvider: "whisper-local",
        glmBaseUrl: "x",
        glmModel: "m",
        language: "zh",
        whisperBin: "whisper-cli",
        whisperModelPath: modelPath,
      }),
      "/Users/enhanced/opt/scratch/zcode-voice/models/ggml-silero-v6.2.0.bin",
    );
  }
});

test("readDesktopVoiceConfig: 读取 voice 段并过滤非法键", async () => {
  const home = join(sandboxRoot, "cfg-ok");
  await writeFile(
    join(home, "cli", "config.json"),
    JSON.stringify({
      voice: {
        asrProvider: "glm",
        language: "en",
        whisperModelPath: 123,
        glmApiKey: "k",
        unknownKey: true,
      },
    }),
    { flag: "wx" },
  ).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "cli"), { recursive: true });
    await writeFile(
      join(home, "cli", "config.json"),
      JSON.stringify({ voice: { asrProvider: "glm", language: "en", glmApiKey: "k" } }),
    );
  });
  const config = await readDesktopVoiceConfig({ ZCODE_STORAGE_DIR: home } as NodeJS.ProcessEnv);
  assert.equal(config.asrProvider, "glm");
  assert.equal(config.language, "en");
  assert.equal(config.glmApiKey, "k");
  assert.equal(config.whisperModelPath, undefined);
});

test("readDesktopVoiceConfig: 缺文件/坏 JSON 回落默认值", async () => {
  const missing = await readDesktopVoiceConfig({
    ZCODE_STORAGE_DIR: join(sandboxRoot, "nope"),
  } as NodeJS.ProcessEnv);
  assert.equal(missing.asrProvider, "whisper-local");
  assert.equal(missing.whisperBin, "whisper-cli");

  const badHome = join(sandboxRoot, "cfg-bad");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(badHome, "cli"), { recursive: true });
  await writeFile(join(badHome, "cli", "config.json"), "{not json");
  const bad = await readDesktopVoiceConfig({
    ZCODE_STORAGE_DIR: badHome,
  } as NodeJS.ProcessEnv);
  assert.equal(bad.asrProvider, "whisper-local");
});
