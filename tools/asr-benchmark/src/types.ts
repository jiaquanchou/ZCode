/**
 * ASR benchmark 类型定义。
 * 独立于 ZCode app 运行（纯 Node + tsx），复用仓库根 node_modules。
 */

/** 参考文本类别。 */
export type ReferenceCategory =
  | "general_zh"
  | "zh_en_mix"
  | "coding_terms"
  | "long_sentence"
  | "noisy"
  | "silence";

/** references.jsonl 每行一条。 */
export type ReferenceItem = {
  /** 唯一 id。 */
  id: string;
  /** 相对 audio/ 目录的音频文件名（16k mono wav）。 */
  audio: string;
  /** 参考文本（ground truth，口语原文）。 */
  text: string;
  /** 需要独立统计 recall 的技术词。 */
  terms: string[];
  /** 类别。 */
  category: ReferenceCategory;
  /** 音频时长（秒），可选；缺省时 runner 用波形头推算。 */
  durationSeconds?: number;
};

/** 单条录音的度量结果。 */
export type SampleMetrics = {
  id: string;
  category: ReferenceCategory;
  /** 转写原文（hypothesis）。 */
  hypothesis: string;
  /** 参考文本。 */
  reference: string;
  rawCer: number;
  normalizedCer: number;
  /** 字符级编辑距离（归一化后）。 */
  editDistance: number;
  referenceLength: number;
  /** 参考技术词。 */
  referenceTerms: string[];
  /** 技术词命中列表。 */
  hitTerms: string[];
  missedTerms: string[];
  /** hypothesis 中出现的参考技术词（去重后）。 */
  recognizedTerms: string[];
  /** 转写产生的技术词（用于 precision 误报计数）。 */
  hypothesisTerms: string[];
  /** 本条的技术词 precision（命中去重 / hypothesis 术语数）。 */
  technicalTermPrecision: number;
  /** 音频时长（秒）。 */
  audioSeconds: number;
  /** 纯 ASR 推断时间（秒），不含进程启动/模型加载。 */
  inferenceSeconds: number;
  /** 端到端墙钟（秒，含 spawn/加载）。 */
  wallSeconds: number;
  /** 实时因子 = 推断时间 / 音频时长。 */
  rtf: number;
  /** 转写时进程 RSS（MB）。 */
  rssMb: number;
  /** 峰值 RSS（MB）。 */
  peakRssMb: number;
};

/** 聚合结果（按 provider 输出一个文件）。 */
export type ProviderBenchmark = {
  provider: string;
  /** 引擎/模型描述（版本锚点，禁止浮动）。 */
  engine: {
    name: string;
    version?: string;
    model: string;
    quantization?: string;
    runtime?: string;
  };
  generatedAt: string;
  counts: {
    total: number;
    [category: string]: number;
  };
  /** 逐条度量。 */
  samples: SampleMetrics[];
  aggregate: {
    rawCer: number;
    normalizedCer: number;
    technicalTermRecall: number;
    technicalTermPrecision: number;
    /** P50 延迟（秒）。 */
    latencyP50: number;
    /** P95 延迟（秒）。 */
    latencyP95: number;
    meanRtf: number;
    meanRssMb: number;
    peakRssMb: number;
    /** 冷启动时间（第一次转写墙钟，含模型加载）。 */
    coldStartSeconds: number;
    /** 温热推断平均时间（第 2 次起）。 */
    warmInferenceSeconds: number;
  };
  /** 按类别聚合。 */
  byCategory: Record<string, {
    count: number;
    rawCer: number;
    normalizedCer: number;
    technicalTermRecall: number;
    technicalTermPrecision: number;
  }>;
};