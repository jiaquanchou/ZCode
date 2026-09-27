# 目标架构（Target Architecture）

## 已落地

```
Renderer
  getUserMedia(48k mono, AGC/NS/EC)
  → ScriptProcessor 采集 + AnalyserNode 电平
  → 线性重采样 16k PCM16
  → IPC voice:transcribe(pcm16, sampleRate, prompt)

Electron main
  → AsrManager（provider 选择 + fallback + 统计）
      ├─ 首选: whisper-resident（whisper-server 常驻子进程，模型加载一次）
      └─ fallback: whisper spawn（每次起进程，永远保留）
  → 段级时间戳结果
  → 文本注入输入框（preview 灰字 + final 权威文本分离）
```

- preview：600ms tick rolling 全量重转；>30s 冻结前缀（2s overlap），只重转尾部
- final：stop() 后整段权威转写（带同一 prompt），1.2s 内新鲜预览直接沿用（零跳变）
- 静音防线（三层）：renderer 波形 + main analyzePcm16 全零预检 + whisper Silero VAD

## 待实施（P1/P2 遗留）

```
AsrManager
  → Persistent Asr Worker（sherpa-onnx 常驻子进程）   ← SenseVoice 质量待解
  → ITN / punctuation model（sherpa punct 或 LLM 标点）
  → technical-term correction（workspace 动态词表）
  → restricted LLM correction（已实现 fail-open 库，待接凭据通道）
```

## Provider 扩展点

新引擎只需：实现 `AsrProvider`（transcribe/health/dispose）→ 在 `AsrManager.create`
注册 → 配置 `asrProvider` 枚举扩展。UI/IPC 层零改动（已由 whisper-resident/glm 验证）。
