# 最终决策（Final Decision）

基于 `engine-comparison.md` 的实测数据（非厂商 benchmark）：

## 决策

1. **默认引擎保持 whisper large-v3-turbo q5_0**（常驻 whisper-server + Silero VAD
   + initial_prompt 技术词热表）：
   - normCER 0.0404 vs SenseVoice 0.3133——质量差距 8 倍，直接否决「换 SenseVoice」。
   - 技术词 recall 0.714 vs 0.286——initial_prompt 热表是该场景的胜负手。
2. **SenseVoice 不替换、不删除**：
   - RTF 0.020（快 6 倍）+ 模型 239MB——当「极低延迟草稿」成为需求时可作为
     preview 专用引擎（final 仍用 whisper），或作为低配设备选项。
   - 静音幻觉（韩文字符）已由三层防线前置拦截。
3. **Paraformer + hotword**：模型下载全渠道失败（hf/modelscope 均不可达或 404），
   PoC 挂起；工具已就绪（provider 骨架），模型可得时按同 benchmark 补测。
4. **LLM restricted correction**：已实现（fail-open，6 类白名单 + from 校验 +
   预算截断）。接入需要桌面侧 GLM 凭据通道，默认关闭。
5. **重采样**：维持线性插值（调研结论：先证明 CER 收益再引依赖）。

## 后续触发条件（何时重启引擎换型）

- 录制真实语音 benchmark（100+ 条）后重跑：若 whisper 的 normCER 在真实口语上
  劣势依然明显，重启 SenseVoice PoC（需先解决其热词/技术词方案）。
- Paraformer 模型可下载时，补 hotword 对比。

## 已知问题（Known Issues）

见 `known-issues.md`。
