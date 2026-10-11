import assert from "node:assert/strict";
import { test } from "node:test";
import { appendVoiceText, insertableVoiceText } from "../src/app-voice-text.js";

test("insertableVoiceText: 空草稿直接返回文本", () => {
  assert.equal(insertableVoiceText("", 0, "你好"), "你好");
});

test("insertableVoiceText: 光标在末尾且前字符非空白时补一个空格", () => {
  assert.equal(insertableVoiceText("帮我看下", 4, "这个函数"), " 这个函数");
});

test("insertableVoiceText: 前字符是空白不再补空格", () => {
  assert.equal(insertableVoiceText("帮我看下 ", 5, "这个函数"), "这个函数");
});

test("insertableVoiceText: 光标在中间不补空格", () => {
  assert.equal(insertableVoiceText("ab", 1, "X"), "X");
});

test("appendVoiceText: 无编辑器兜底时追加到非空草稿末尾", () => {
  assert.equal(appendVoiceText("帮我看下", "这个函数"), "帮我看下 这个函数");
});

test("appendVoiceText: 空草稿直接返回文本", () => {
  assert.equal(appendVoiceText("", "你好"), "你好");
});

test("appendVoiceText: 草稿尾部空白被收敛为单个空格", () => {
  assert.equal(appendVoiceText("帮我看下\n  ", "这个函数"), "帮我看下 这个函数");
});
