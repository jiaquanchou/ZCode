import assert from "node:assert/strict";
import { test } from "node:test";
import { editDistance, computeCer, computeTermMetrics, percentile, mean } from "../src/metrics.js";
import { normalizeForCer, normalizeText } from "../src/normalize.js";

test("editDistance: 基本编辑距离", () => {
  assert.equal(editDistance("", ""), 0);
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("abc", "ac"), 1); // 删除 b
  assert.equal(editDistance("abc", "abd"), 1); // 替换 c→d
  assert.equal(editDistance("abc", "abcd"), 1); // 插入 d
  assert.equal(editDistance("", "abc"), 3);
});

test("normalizeForCer: 去标点/空白 + 小写 + 全半角", () => {
  assert.equal(normalizeForCer("Hello, World! 你好，世界！"), "helloworld你好世界");
  assert.equal(normalizeForCer("ＡＢＣ１２３"), "abc123");
  assert.equal(normalizeForCer("（测试）"), "测试");
});

test("normalizeText: 数字形状归一", () => {
  assert.equal(normalizeText("端口 08080"), "端口8080");
  assert.equal(normalizeText("版本 1.0.1"), "版本101");
  // 中文数字不强行转换（保持语义）
  assert.equal(normalizeText("一百二十八"), "一百二十八");
});

test("computeCer: 完全一致为 0", () => {
  const result = computeCer("我们使用 PostgreSQL", "我们使用 PostgreSQL");
  assert.equal(result.rawCer, 0);
  assert.equal(result.normalizedCer, 0);
});

test("computeCer: 忽略标点后 normalized CER 为 0", () => {
  const result = computeCer("我们，使用 PostgreSQL。", "我们使用 PostgreSQL");
  assert.equal(result.rawCer > 0, true); // 裸 CER 被标点拉高
  assert.equal(result.normalizedCer, 0); // 归一化后为 0
});

test("computeCer: 同音字错误会被计入 normalized CER", () => {
  // 「登录」写错成「登陆」——归一化只处理表象，不改语义，所以仍计入错误
  const result = computeCer("请修复登录超时", "请修复登陆超时");
  assert.equal(result.normalizedCer, 1 / 7);
});

test("computeTermMetrics: 技术词命中与大小写忽略", () => {
  const result = computeTermMetrics(["PostgreSQL", "WebSocket"], "使用 postgresql 和 websocket");
  assert.deepEqual(result.hitTerms, ["PostgreSQL", "WebSocket"]);
  assert.equal(result.recall, 1);
  assert.equal(result.missedTerms.length, 0);
});

test("computeTermMetrics: 漏词时 recall 下降", () => {
  const result = computeTermMetrics(["PostgreSQL", "Kubernetes"], "使用 PostgreSQL 做数据库");
  assert.deepEqual(result.hitTerms, ["PostgreSQL"]);
  assert.deepEqual(result.missedTerms, ["Kubernetes"]);
  assert.equal(result.recall, 0.5);
});

test("computeTermMetrics: 多词术语匹配（Claude Code）", () => {
  const result = computeTermMetrics(["Claude Code"], "用 Claude Code 写代码");
  assert.equal(result.recall, 1);
});

test("percentile / mean", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([], 50), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([]), 0);
});
