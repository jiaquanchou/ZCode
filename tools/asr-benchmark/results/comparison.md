# ASR 引擎对比（smoke 集：6 条 say 合成中文音频，M5 / macOS 26）

> 数据不足，仅为框架验证与初步结论；非统计显著结论。

| provider | normCER | rawCER | termRecall | termPrecision | P50(s) | P95(s) | RTF | peakRSS(MB) | cold(s) | warmInf(s) | n |
|---|---|---|---|---|---|---|---|---|---|---|---|
| whisper | 0.0404 | 0.1449 | 0.714 | 0.667 | 0.73 | 1.10 | 0.121 | 840 | 1.10 | 0.664 | 6 |
| sensevoice | 0.3133 | 0.4250 | 0.286 | 0.500 | 0.04 | 0.49 | 0.020 | 0 | 0.49 | 0.131 | 6 |