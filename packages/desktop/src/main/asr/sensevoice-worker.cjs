#!/usr/bin/env node
/**
 * SenseVoice 常驻 ASR worker（CJS + 二进制帧协议，由 spawn 拉起）。
 *
 * 协议（stdin/stdout，帧 = [4B 大端长度][payload]）：
 *   main → worker：
 *     帧 A（JSON）: { type:"transcribe", id, sampleRate, prompt, pcmBytes }
 *     帧 B（raw）  : PCM16 小端裸数据（pcmBytes 字节）
 *   worker → main（每帧 payload 均为 JSON 文本）：
 *     {"type":"ready"}
 *     {"type":"result","id":N,"text":"...","inferenceSeconds":0.05}
 *     {"type":"error","id":N,"message":"..."}
 *
 * 模型启动时加载一次并常驻；decode 同步阻塞（worker 专职转写，无害）。
 * 静音防线在 main 侧前置（analyzePcm16），worker 不做幻觉防护。
 */
"use strict";
const sherpa = require("sherpa-onnx-node");

const MODEL = process.env.SENSEVOICE_MODEL || "";
const TOKENS = process.env.SENSEVOICE_TOKENS || "";
const THREADS = Number(process.env.SENSEVOICE_THREADS || "4");
const USE_ITN = process.env.SENSEVOICE_ITN !== "0";

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

const frames = []; // 队列：JSON 帧 + PCM 帧成对出现
let pendingPcm = null;
let recognizer = null;
let buffer = Buffer.alloc(0);

function handleFrame(payload) {
  if (pendingPcm === null) {
    const meta = JSON.parse(payload.toString("utf8"));
    if (meta.type === "transcribe") {
      pendingPcm = { meta, pcm: Buffer.alloc(0) };
    }
    return;
  }
  pendingPcm.pcm = Buffer.concat([pendingPcm.pcm, payload]);
  if (pendingPcm.pcm.length >= pendingPcm.meta.pcmBytes) {
    frames.push(pendingPcm);
    pendingPcm = null;
    processQueue();
  }
}

function processQueue() {
  while (frames.length > 0 && recognizer) {
    const item = frames.shift();
    if (!item) return;
    const { meta, pcm } = item;
    const id = meta.id;
    try {
      const samples = new Float32Array(pcm.length / 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = pcm.readInt16LE(index * 2) / 32768;
      }
      const started = process.hrtime.bigint();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: meta.sampleRate });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      const inferenceSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      send({
        type: "result",
        id,
        text: (result.text || "").trim(),
        inferenceSeconds,
      });
    } catch (error) {
      send({ type: "error", id, message: error.message });
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const frameLength = buffer.readUInt32BE(0);
    if (buffer.length < 4 + frameLength) break;
    const payload = buffer.subarray(4, 4 + frameLength);
    buffer = buffer.subarray(4 + frameLength);
    handleFrame(payload);
  }
});

try {
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: MODEL, tokens: TOKENS, useInverseTextNormalization: USE_ITN ? 1 : 0 },
      tokens: TOKENS,
      numThreads: THREADS,
      debug: 0,
      provider: "cpu",
    },
    decodingMethod: "greedy_search",
  });
  send({ type: "ready" });
} catch (error) {
  send({ type: "fatal", message: `模型加载失败: ${error.message}` });
  process.exit(1);
}
