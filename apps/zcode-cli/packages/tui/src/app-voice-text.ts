// 语音转写文本注入的纯函数层：无 React / OpenTUI 依赖，便于单测与复用。

export function insertableVoiceText(plainText: string, cursorOffset: number, text: string): string {
  if (plainText.length === 0) return text;
  const atEnd = cursorOffset >= plainText.length;
  if (!atEnd) return text;
  const previous = plainText[plainText.length - 1];
  return /\s/u.test(previous) ? text : ` ${text}`;
}

export function appendVoiceText(draft: string, text: string): string {
  const trimmed = draft.trimEnd();
  return trimmed ? `${trimmed} ${text}` : text;
}
