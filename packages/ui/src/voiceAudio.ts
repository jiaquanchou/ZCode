// 语音采集的纯函数层：重采样与整型化，无 DOM/Electron 依赖，便于单测。
// 桌面端 renderer 采集到的 PCM 是 AudioContext 的 Float32（常见 48k），
// whisper 侧统一吃 16k mono Int16，转换收敛在这里。

export const VOICE_TARGET_SAMPLE_RATE = 16_000;

/** 线性插值重采样 Float32 单声道到目标采样率。 */
export function downsampleLinear(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (inputSampleRate === targetSampleRate || input.length === 0) return input;
  if (inputSampleRate <= 0 || targetSampleRate <= 0) return input;
  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const weight = position - left;
    const leftSample = input[left] ?? 0;
    const rightSample = input[right] ?? 0;
    output[index] = leftSample * (1 - weight) + rightSample * weight;
  }
  return output;
}

/** Float32 [-1, 1] → Int16 PCM，越界截断。 */
export function float32ToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, input[index] ?? 0));
    output[index] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return output;
}

/** 合并采集分片（ScriptProcessor 每次回调一小段）。 */
export function mergeFloat32Chunks(chunks: readonly Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
