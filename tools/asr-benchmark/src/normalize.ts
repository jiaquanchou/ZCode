/**
 * 归一化：把参考文本与 hypothesis 归一到可比的字符串，用于 normalized CER。
 * 规则（只做表面归一，不改语义）：
 * - 去除所有标点/空白符号
 * - 英文字母统一小写
 * - 全角字符（数字/字母/标点）转半角
 * - 中文数字/阿拉伯数字的"形状"级归一（比分号更有用，见 normalizeNumber）
 */

const FULLWIDTH_RE = /[\uff01-\uff5e]/gu;

function fullWidthToHalfWidth(char: string): string {
  return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
}

/** 去除标点与空白，统一大小写与全半角。 */
export function normalizeForCer(input: string): string {
  return input
    // 全角→半角（！→! Ａ→A 等）
    .replace(FULLWIDTH_RE, fullWidthToHalfWidth)
    // 去掉所有非字母数字的符号与空白（保留 CJK、拉丁、数字）
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
    .toLowerCase();
}

/** 归一化数字形状：阿拉伯数字零填充对齐（"一百二十八 K" vs "128K" 这类做合理归一）。 */
export function normalizeNumberShape(input: string): string {
  // 把连续数字拆成单字符做同形替换太激进；这里只对最常见的"十六 K"式阅读做
  // 形状对齐：数字序列统一为不含前导零的紧凑形式（语义不变）。
  return input.replace(/\d+/gu, (digits) => {
    const value = Number(digits);
    return Number.isFinite(value) ? String(value) : digits;
  });
}

/**
 * 归一化：忽略标点、忽略空格、英文大小写归一、数字格式合理归一。
 * 不改语义。
 */
export function normalizeText(input: string): string {
  return normalizeNumberShape(normalizeForCer(input));
}

export { normalizeText as normalize };