# ASR Benchmark

`ZCode` 语音输入的引擎横评工具。目标是**用自有数据**决定引擎选型（whisper / SenseVoice / Paraformer），不依赖厂商 benchmark。

## 目录

```
audio/            # 音频样本（16k mono wav）
references.jsonl  # 参考文本/技术词/类别（每行一条 JSON）
src/
  types.ts        # ReferenceItem / SampleMetrics / ProviderBenchmark
  normalize.ts    # CER 归一化（去标点/小写/全半角/数字形状）
  metrics.ts      # 字符级编辑距离 CER、技术词 recall/precision、percentile
  runner.ts       # 主 runner（逐条转写 → 指标聚合 → results/）
  providers/
    provider.ts   # AsrBenchmarkProvider 统一接口
    whisper.ts    # whisper-cli provider（含 macOS RSS 测量）
scripts/record.sh # 录音工具：交互式录 16k mono + 追加 references.jsonl
test/             # 指标计算单测（node:test + tsx）
results/          # 输出（<provider>.json / .csv / comparison.*）
```

## 类别

`general_zh` / `zh_en_mix` / `coding_terms` / `long_sentence` / `noisy` / `silence`

## 运行

```bash
# 仓库根目录执行（复用根 node_modules 的 tsx）

# whisper（带 Silero VAD，对齐生产链路）
node_modules/.bin/tsx tools/asr-benchmark/src/runner.ts --provider whisper --vad

# 跑完所有 provider 后（sensevoice/paraformer 实现后）：
node_modules/.bin/tsx tools/asr-benchmark/src/runner.ts --provider sensevoice
node_modules/.bin/tsx tools/asr-benchmark/src/runner.ts --provider paraformer
# → results/comparison.md / comparison.csv 自动生成（≥2 个 provider 结果时）
```

可选参数：

| 参数 | 说明 |
|---|---|
| `--provider <name>` | whisper / sensevoice / paraformer（后两者待 PoC） |
| `--refs <path>` | references.jsonl 路径（默认 tools/asr-benchmark/references.jsonl） |
| `--audio-dir <path>` | 音频目录（默认 audio/） |
| `--out <path>` | 结果目录（默认 results/） |
| `--vad` | whisper 启用 Silero VAD（对齐生产） |
| `--prompt "..."` | 注入 initial_prompt / hotword 上下文（对比热词收益用） |

环境变量：`WHISPER_BIN`、`WHISPER_MODEL`、`WHISPER_VAD`（缺省走本机 whisper.cpp 路径）。

## 录制真实语音集

```bash
bash tools/asr-benchmark/scripts/record.sh coding_terms
# 说话 → Ctrl+C 停止 → 输入参考文本与技术词 → 自动追加 references.jsonl
```

目标 100~300 条：普通中文 30% / 中英混说 20% / 编程术语 30% / 长句 10% / 噪声停顿 10%。

## 指标口径

- **raw CER / normalized CER**：字符级编辑距离 / 参考长度；normalized 忽略标点、空格、大小写，数字形状合理归一（不改语义）。
- **技术词 recall / precision**：术语归一化后精确匹配；recall = 命中/参考术语数，precision = 命中去重/hypothesis 术语数（防误报）。
- **P50/P95**：端到端墙钟延迟。
- **RTF**：纯推断时间 / 音频时长。
- **RSS / peak RSS**：macOS 用 `/usr/bin/time -l` 包裹 whisper 测峰值；其他平台为 0（待补）。
- **cold start**：第一条的墙钟（含模型加载）；**warm inference**：total time 均值。

## 已知限制

- 当前 smoke 集仅 6 条（say 合成），结论仅作框架验证，**不构成统计结论**。
- 真实录音集 + 类别均衡是本工具当前最重要待补项。
- Linux RSS 测量未实现。
