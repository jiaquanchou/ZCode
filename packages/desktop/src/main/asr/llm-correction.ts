/**
 * Restricted LLM Correction（规格第十五节，fail-open）：
 * - 只允许纠：homophone / technical_term / case / spacing / punctuation / number_format
 * - 禁止改写原意；程序端强制校验 original.slice(start, end) === from
 * - 修改字符总量 <= max(10, 原文长度 * 15%)，超预算按 confidence 贪心保留
 * - LLM 不可用/任何异常 → 原样返回 ASR 文本（fail-open，绝不阻塞主链路）
 */

export const LLM_CORRECTION_TYPES = [
  "homophone",
  "technical_term",
  "case",
  "spacing",
  "punctuation",
  "number_format",
] as const;

export type LlmCorrectionType = (typeof LLM_CORRECTION_TYPES)[number];

export type LlmCorrectionEdit = {
  start: number;
  end: number;
  from: string;
  to: string;
  type: LlmCorrectionType;
  confidence: number;
};

export type LlmCorrectionResult = {
  text: string;
  /** 实际应用的 edit 数；0 = 未纠错或纠错被全部拒绝。 */
  appliedEdits: number;
  rejectedEdits: number;
};

export type LlmChatClient = (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;

const MIN_ABSOLUTE_EDIT_BUDGET = 10;
const MAX_RELATIVE_EDIT_RATIO = 0.15;
const MAX_TEXT_LENGTH = 2_000;

function buildPrompt(text: string, glossary: readonly string[]): string {
  const glossaryLine = glossary.length > 0 ? glossary.join("、") : "（无）";
  return [
    "你是 ASR（语音识别）文本校对器。只修正以下几类错误，禁止改写、润色、扩写、总结或调整语序：",
    "1) 同音字错别字 2) 技术术语拼写 3) 英文大小写 4) 中英文之间的空格 5) 标点 6) 数字格式。",
    `可用技术词表：${glossaryLine}`,
    '输出严格 JSON：{"edits":[{"start":数字,"end":数字,"from":"原文片段","to":"修正后","type":"homophone|technical_term|case|spacing|punctuation|number_format","confidence":0到1}]}',
    "start/end 是字符偏移（含头不含尾）。不修改任何内容时输出 {\"edits\":[]}。只输出 JSON，不要解释。",
    "",
    "原文：",
    text,
  ].join("\n");
}

/** 解析并验证 LLM 输出的 edits；任何不合规 edit 直接拒绝，不影响其他 edit。 */
export function applyCorrections(
  original: string,
  editsJson: string,
  options: { maxEdits?: number } = {},
): LlmCorrectionResult {
  let parsed: { edits?: unknown };
  try {
    parsed = JSON.parse(editsJson) as { edits?: unknown };
  } catch {
    return { text: original, appliedEdits: 0, rejectedEdits: 0 };
  }
  const rawEdits = Array.isArray(parsed.edits) ? parsed.edits : [];
  const budget =
    options.maxEdits ?? Math.max(MIN_ABSOLUTE_EDIT_BUDGET, Math.floor(original.length * MAX_RELATIVE_EDIT_RATIO));

  type Candidate = LlmCorrectionEdit & { changed: number };
  const candidates: Candidate[] = [];
  let rejected = 0;

  for (const raw of rawEdits) {
    const edit = raw as Partial<LlmCorrectionEdit>;
    if (
      typeof edit.start !== "number" ||
      typeof edit.end !== "number" ||
      typeof edit.from !== "string" ||
      typeof edit.to !== "string" ||
      typeof edit.type !== "string" ||
      !LLM_CORRECTION_TYPES.includes(edit.type as LlmCorrectionType) ||
      typeof edit.confidence !== "number" ||
      edit.start < 0 ||
      edit.end > original.length ||
      edit.start >= edit.end ||
      original.slice(edit.start, edit.end) !== edit.from ||
      edit.from === edit.to
    ) {
      rejected += 1;
      continue;
    }
    candidates.push({
      ...(edit as LlmCorrectionEdit),
      changed: Math.max(edit.from.length, edit.to.length),
    });
  }

  // 预算内按 confidence 贪心保留；start 降序应用避免偏移失效。
  const ordered = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const accepted: Candidate[] = [];
  let used = 0;
  for (const edit of ordered) {
    if (used + edit.changed > budget) {
      rejected += 1;
      continue;
    }
    used += edit.changed;
    accepted.push(edit);
  }
  accepted.sort((a, b) => b.start - a.start);

  let text = original;
  for (const edit of accepted) {
    text = text.slice(0, edit.start) + edit.to + text.slice(edit.end);
  }

  return { text, appliedEdits: accepted.length, rejectedEdits: rejected };
}

/** 端到端：调 LLM → 校验 → 应用。任何异常返回原文本（fail-open）。 */
export async function correctWithLlm(
  original: string,
  glossary: readonly string[],
  chat: LlmChatClient,
  options: { signal?: AbortSignal } = {},
): Promise<LlmCorrectionResult> {
  try {
    if (!original.trim() || original.length > MAX_TEXT_LENGTH) {
      return { text: original, appliedEdits: 0, rejectedEdits: 0 };
    }
    const editsJson = await chat(buildPrompt(original, glossary), options);
    return applyCorrections(original, editsJson);
  } catch {
    return { text: original, appliedEdits: 0, rejectedEdits: 0 };
  }
}
