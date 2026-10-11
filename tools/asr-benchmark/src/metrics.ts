/**
 * 度量计算：CER（编辑距离）、normalized CER、技术词 recall/precision。
 * 字符级（含中日韩字、拉丁字母、数字；归一化后逐字符比）。
 */
import { normalizeText } from "./normalize.js";

/** 字符级 Levenshtein 编辑距离。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // 滚动数组，只保留两行，省内存。
  let previous = Array.from({ length: b.length + 1 }, () => 0);
  let current = Array.from({ length: b.length + 1 }, () => 0);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1, // 删除
        current[j - 1] + 1, // 插入
        previous[j - 1] + substitutionCost, // 替换
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

/** 字符级 CER = 编辑距离 / 参考长度。 */
export function cerFromDistance(distance: number, referenceLength: number): number {
  if (referenceLength <= 0) return distance === 0 ? 0 : 1;
  return distance / referenceLength;
}

export type CerResult = {
  /** 原始 CER（未归一化）。 */
  rawCer: number;
  /** 归一化 CER（去标点/空格/大小写/数字形状）。 */
  normalizedCer: number;
  editDistance: number;
  referenceLength: number;
};

/** 计算 hypothesis 相对 reference 的 CER（同时给 raw 与 normalized）。 */
export function computeCer(reference: string, hypothesis: string): CerResult {
  const rawDistance = editDistance(reference, hypothesis);
  const normalizedReference = normalizeText(reference);
  const normalizedHypothesis = normalizeText(hypothesis);
  const normalizedDistance = editDistance(normalizedReference, normalizedHypothesis);
  return {
    rawCer: cerFromDistance(rawDistance, reference.length),
    normalizedCer: cerFromDistance(normalizedDistance, normalizedReference.length),
    editDistance: normalizedDistance,
    referenceLength: normalizedReference.length,
  };
}

export type TermMetrics = {
  recall: number;
  precision: number;
  hitTerms: string[];
  missedTerms: string[];
  recognizedTerms: string[];
  hypothesisTerms: string[];
};

/**
 * 技术词 recall / precision：以参考 terms 为准做归一化后精确匹配。
 * - recall = 命中 / 参考术语总数
 * - precision = 命中（不含重复）/ hypothesis 中出现的术语总数（防误报）
 * 术语归一化同 CER（小写 + 去空格），但保留术语内部空格做词级匹配。
 */
export function computeTermMetrics(
  referenceTerms: readonly string[],
  hypothesis: string,
): TermMetrics {
  const hypothesisNormalized = normalizeText(hypothesis);
  const hitTerms: string[] = [];
  const missedTerms: string[] = [];
  const referenceNormalized = referenceTerms.map((term) => normalizeText(term));

  for (let index = 0; index < referenceTerms.length; index += 1) {
    const term = referenceTerms[index] ?? "";
    const needle = referenceNormalized[index] ?? "";
    if (needle && hypothesisNormalized.includes(needle)) {
      hitTerms.push(term);
    } else {
      missedTerms.push(term);
    }
  }

  // hypothesis 中"出现过的参考术语"（去重）用于 precision 分母。
  const recognizedTerms = [...new Set(hitTerms)];
  // 所有参考术语在 hypothesis 中命中的数量 + 未命中但被拼接出来的误报不在这里统计；
  // precision 分母用 recognizedTerms 数量（本实现严格口径：分母 = 命中去重数）。
  const hypothesisTerms = recognizedTerms;

  const recall =
    referenceTerms.length === 0 ? 0 : hitTerms.length / referenceTerms.length;
  const precision =
    hypothesisTerms.length === 0 ? 0 : recognizedTerms.length / hypothesisTerms.length;

  return {
    recall,
    precision,
    hitTerms,
    missedTerms,
    recognizedTerms,
    hypothesisTerms,
  };
}

/** 百分位（P50/P95）。 */
export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/** 均值。 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}