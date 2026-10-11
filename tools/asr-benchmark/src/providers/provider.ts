/**
 * ASR 引擎基准接口：各引擎（whisper / sensevoice / paraformer）统一实现。
 * 输出对齐 SampleMetrics，保证横评可比。
 */
import type { ReferenceCategory } from "../types.js";

export type Segment = {
  start: number;
  end: number;
  text: string;
};

export type TranscribeInput = {
  /** wav 绝对路径（16k mono）。 */
  wavPath: string;
  /** 音频时长（秒）。 */
  audioSeconds: number;
  /** 可选 initial_prompt / hotword 上下文。 */
  prompt?: string;
  /** 类别（silence 类别下引擎应返回空文本，否则记为幻觉）。 */
  category: ReferenceCategory;
};

export type TranscribeOutput = {
  text: string;
  segments: Segment[];
  /** 纯推断时间（秒，不含进程启动/模型加载）。 */
  inferenceSeconds: number;
  /** 端到端墙钟（秒）。 */
  wallSeconds: number;
  /** 进程 RSS（MB），不可测时为 0。 */
  rssMb: number;
  /** 峰值 RSS（MB），不可测时为 0。 */
  peakRssMb: number;
  /** 冷启动（模型加载）时间（秒）。 */
  loadSeconds: number;
};

export interface AsrBenchmarkProvider {
  readonly name: string;
  readonly engine: {
    name: string;
    version?: string;
    model: string;
    quantization?: string;
    runtime?: string;
  };
  transcribe(input: TranscribeInput): Promise<TranscribeOutput>;
}