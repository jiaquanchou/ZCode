/**
 * ASR Provider 抽象：让 UI/Manager 不直接依赖具体引擎（whisper / GLM /
 * 未来 SenseVoice / Paraformer）。
 *
 * 当前实现阶段为「一次性全量转写」接口（与现有行为一致，不破坏已可用链路）；
 * 流式（feedAudio/startSession/finishSession）在常驻 worker 阶段叠加。
 */

export type AsrSegment = {
  start: number;
  end: number;
  text: string;
};

export type AsrTranscribeOptions = {
  pcm16: Int16Array;
  sampleRate: number;
  /** initial_prompt / 热词上下文。 */
  prompt?: string;
  /** 供 benchmark/诊断使用的类别标注（silence 等）。 */
  category?: string;
};

export type AsrTranscribeResult = {
  segments: AsrSegment[];
  /** 拼接文本。 */
  text: string;
  /** 纯推断时间（秒）。 */
  inferenceSeconds: number;
  /** 端到端墙钟（秒）。 */
  wallSeconds: number;
  /** 峰值 RSS（MB），不可测为 0。 */
  peakRssMb: number;
};

export type AsrProviderHealth = {
  ok: boolean;
  detail?: string;
  lastError?: string;
};

export interface AsrProvider {
  /** 稳定 id：whisper-local / glm / sensevoice / paraformer。 */
  readonly id: string;
  transcribe(options: AsrTranscribeOptions): Promise<AsrTranscribeResult>;
  health(): Promise<AsrProviderHealth>;
  dispose(): Promise<void>;
}

/** AsrManager.transcribe 的返回：附加实际使用的 provider 与是否发生了 fallback。 */
export type AsrManagedResult = AsrTranscribeResult & {
  provider: string;
  fallbackUsed: boolean;
  /** 本次调用的错误信息（fallback 后为原错误摘要），无错误为 undefined。 */
  primaryError?: string;
};
