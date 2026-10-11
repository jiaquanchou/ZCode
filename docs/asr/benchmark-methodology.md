# Benchmark 方法论（Benchmark Methodology）

工具：`tools/asr-benchmark/`（详见该目录 README）。

## 数据集

- **当前**：6 条 say 合成中文音频（Tingting 音色，48k→16k mono），类别覆盖
  coding_terms ×3、general_zh ×1、long_sentence ×1、silence ×1。
- **目标**：100~300 条真实录音（`scripts/record.sh` 交互式录制并自动登记），
  比例：普通中文 30% / 中英混说 20% / 编程术语 30% / 长句 10% / 噪声停顿 10%。
- **诚实声明**：6 条合成样本的结论仅为框架验证与方向性参考，不构成统计显著结论。

## 指标

1. **raw CER**：字符级编辑距离 / 参考长度（含标点）。
2. **normalized CER**：归一化后（去标点/空白、英文小写、全半角、数字形状）——消除「标点风格差异」对引擎横评的污染。
3. **technical term recall / precision**：参考技术词归一化后精确匹配；precision 分母为 hypothesis 中出现的去重术语（防「只报命中」的虚高）。
4. **latency P50/P95**：端到端墙钟。
5. **RTF**：纯推断时间 / 音频时长。
6. **peak RSS**：macOS `/usr/bin/time -l`（Linux 未实现，记 0）。
7. **cold start / warm inference**：首条墙钟 / total time 均值。

## 公平性规则

- 同一批音频跑所有引擎。
- 引擎各自的**生产等价配置**参与横评：whisper 带 Silero VAD + initial_prompt 热表
  （生产语义）；SenseVoice 开 ITN、不带热词（sherpa SenseVoice 不支持 hotword，
  该差距如实记录）。
- 禁止仅凭厂商 benchmark 下结论；一切以本工具输出为准。
