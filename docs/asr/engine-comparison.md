# 引擎对比（Engine Comparison）

数据源：`tools/asr-benchmark/results/comparison.md`（smoke 集 6 条，say 合成中文，
M5 / macOS 26 / whisper.cpp 1.9.4 Metal / sherpa-onnx-node 1.13.8）。

## 汇总

| provider | normCER | rawCER | termRecall | termPrecision | P50(s) | P95(s) | RTF | peakRSS(MB) |
|---|---|---|---|---|---|---|---|---|
| whisper（VAD+prompt 热表） | **0.0404** | **0.1449** | **0.714** | **0.667** | 0.73 | 1.10 | 0.121 | 840 |
| sensevoice（ITN on，无热词） | 0.3133 | 0.4250 | 0.286 | 0.500 | **0.04** | **0.49** | **0.020** | ~0* |

\* SenseVoice RSS 未接测量（worker 模式），whisper 为 time -l 峰值。

## 逐条观察

- **001/002/004（编程术语短句）**：whisper+prompt 几乎全对（含 PostgreSQL/Nginx）；
  SenseVoice 出现 postg SQL / thinks(Nginx) / cloth coat(Claude Code) / kuubernet(Kubernetes)。
- **005（15.6s 长句）**：SenseVoice 断句更自然（逗号分隔），但术语错误更多；
  whisper 大部分正确。
- **006（3s 静音）**：whisper+VAD 输出空 ✓；SenseVoice 输出韩文幻觉「그.」✗——
  证实**静音防线必须前置到所有引擎**（我们已在 provider 之上实现）。
- **速度**：SenseVoice RTF 0.020（快 whisper 6 倍），warm 推断 40~130ms。

## 已知偏差（诚实声明）

1. whisper 带 initial_prompt 热表、SenseVoice 不支持热词——**生产等价配置对比**
   （真实使用就是 whisper+prompt），但不是「裸引擎」公平对比。
2. 合成音频（播音腔）可能偏向 whisper 类模型；真实口语待 benchmark 扩充。
3. 样本量 6，仅方向性结论。
