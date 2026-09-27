import assert from "node:assert/strict";
import { test } from "node:test";
import { downsampleLinear, float32ToInt16, mergeFloat32Chunks } from "../src/voiceAudio.js";

test("downsampleLinear: 48k→16k 输出长度为 1/3 且零点保持", () => {
  const input = new Float32Array([0, 1, 0, -1, 0, 1]);
  const output = downsampleLinear(input, 48_000, 16_000);
  assert.equal(output.length, 2);
  assert.equal(output[0], 0);
  assert.equal(output[1], -1);
});

test("downsampleLinear: 按比例取点（48k→16k 每 3 点取 1）", () => {
  const output = downsampleLinear(new Float32Array([0, 9, 9, 3, 9, 9]), 48_000, 16_000);
  assert.equal(output.length, 2);
  assert.equal(output[0], 0);
  assert.equal(output[1], 3);
});

test("downsampleLinear: 同采样率直通", () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(downsampleLinear(input, 16_000, 16_000), input);
});

test("downsampleLinear: 空输入安全", () => {
  assert.equal(downsampleLinear(new Float32Array(0), 48_000, 16_000).length, 0);
});

test("float32ToInt16: 正负满幅与越界截断", () => {
  const output = float32ToInt16(new Float32Array([1, -1, 0, 0.5, 2, -2]));
  assert.deepEqual(Array.from(output), [32_767, -32_768, 0, 16_384, 32_767, -32_768]);
});

test("mergeFloat32Chunks: 分片按序拼接", () => {
  const output = mergeFloat32Chunks([new Float32Array([1, 2]), new Float32Array([3])]);
  assert.deepEqual(Array.from(output), [1, 2, 3]);
});

test("mergeFloat32Chunks: 空分片列表返回空数组", () => {
  assert.equal(mergeFloat32Chunks([]).length, 0);
});
