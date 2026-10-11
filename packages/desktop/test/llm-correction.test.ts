import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCorrections, correctWithLlm } from "../src/main/asr/llm-correction.js";

test("applyCorrections: 合法同音字 edit 被应用", () => {
  const original = "请修复登陆超时";
  const edits = JSON.stringify({
    edits: [{ start: 3, end: 5, from: "登陆", to: "登录", type: "homophone", confidence: 0.95 }],
  });
  const result = applyCorrections(original, edits);
  assert.equal(result.text, "请修复登录超时");
  assert.equal(result.appliedEdits, 1);
});

test("applyCorrections: from 不匹配的 edit 被拒绝（防幻觉）", () => {
  const original = "请修复登录超时";
  const edits = JSON.stringify({
    edits: [{ start: 0, end: 2, from: "完全不同", to: "别的", type: "homophone", confidence: 0.9 }],
  });
  const result = applyCorrections(original, edits);
  assert.equal(result.text, original);
  assert.equal(result.appliedEdits, 0);
  assert.equal(result.rejectedEdits, 1);
});

test("applyCorrections: 非法 type 被拒绝（禁止润色/扩写类）", () => {
  const original = "帮我修复登录";
  const edits = JSON.stringify({
    edits: [{ start: 0, end: 6, from: "帮我修复登录", to: "请帮我彻底修复登录问题", type: "polish" as never, confidence: 0.99 }],
  });
  const result = applyCorrections(original, edits);
  assert.equal(result.text, original);
});

test("applyCorrections: 超预算（修改字符 > max(10, 15%)）时按 confidence 截断", () => {
  const original = "abcdefghij"; // 10 字符，预算 = max(10, 1) = 10
  // 三个 edit 各改 8 字符，总 24 > 预算 10 → 只留 confidence 最高的 1 个
  const edits = JSON.stringify({
    edits: [
      { start: 0, end: 8, from: "abcdefgh", to: "AAAAAAAA", type: "technical_term", confidence: 0.6 },
      { start: 2, end: 10, from: "cdefghij", to: "CCCCCCCC", type: "technical_term", confidence: 0.95 },
    ],
  });
  const result = applyCorrections(original, edits);
  assert.equal(result.appliedEdits, 1);
  // confidence 0.95 的后一个被保留
  assert.match(result.text, /CCCCCCCC/);
});

test("correctWithLlm: LLM 抛错时 fail-open 返回原文", async () => {
  const result = await correctWithLlm("帮我看一下", ["Go"], async () => {
    throw new Error("network down");
  });
  assert.equal(result.text, "帮我看一下");
  assert.equal(result.appliedEdits, 0);
});

test("correctWithLlm: LLM 输出非法 JSON 时 fail-open", async () => {
  const result = await correctWithLlm("帮我看一下", ["Go"], async () => "这不是JSON");
  assert.equal(result.text, "帮我看一下");
});

test("correctWithLlm: 正常纠错（postg SQL→PostgreSQL）", async () => {
  const original = "使用 postg sql 作为数据库";
  const chat = async () =>
    JSON.stringify({
      edits: [{ start: 3, end: 12, from: "postg sql", to: "PostgreSQL", type: "technical_term", confidence: 0.97 }],
    });
  const result = await correctWithLlm(original, ["PostgreSQL"], chat);
  assert.equal(result.text, "使用 PostgreSQL 作为数据库");
  assert.equal(result.appliedEdits, 1);
});

test("correctWithLlm: 空文本不调用 LLM", async () => {
  let called = false;
  const result = await correctWithLlm("  ", ["Go"], async () => {
    called = true;
    return "{}";
  });
  assert.equal(called, false);
  assert.equal(result.text, "  ");
});
