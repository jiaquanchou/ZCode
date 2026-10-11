# 当前语音输入架构（Current Architecture）

> 快照：2026-09-27，基于 ZCode v3.14.3 源码 `~/code/opensource/ZCode`。
> 本文是 ASR 质量+架构优化工程的起点文档，记录「重构前」的真实数据流、生命周期、瓶颈与可复用资产。

## 1. 全局概览

语音输入在桌面 App（Electron）与 CLI TUI 两条线上实现，共享同一份配置（`~/.zcode/cli/config.json` 的 `voice` 段）与同一套「whisper / GLM 双后端」思路：

```
Renderer（Electron）
  getUserMedia 48k mono
  → 线性插值重采样 16k PCM16
  → preload window.zcode.voiceTranscribe(pcm16, sampleRate, prompt)
  ↓ IPC "voice:transcribe"
Electron main（desktopVoiceIpc.ts）
  → PCM 健康检查 / 写 wav / 调 desktopVoiceCore
  → whisper-cli（spawn）或 GLM ASR（fetch）
  → 段数组 [{start,end,text}]
```

CLI TUI 是另一条独立线：`sox` 采集 + `whisper-cli`/GLM，走 `@zcode/cli` 包。

## 2. 关键文件

### 桌面 App（产品主线）
| 文件 | 职责 |
|---|---|
| `packages/ui/src/v4/composer/useVoiceRecording.ts` | renderer 录音 hook：getUserMedia、ScriptProcessor 采集、AnalyserNode 电平、rolling 全量重转、`stop()` 观感重构（原文保留+后台 finalize） |
| `packages/ui/src/v4/composer/VoiceInputControl.tsx` | UI 展示件：麦克风入口、录音条（✕/波形/■/➤）、SVG rAF 波形、预览区 |
| `packages/ui/src/v4/ConversationComposer.tsx` | 接线层：600ms tick 驱动 preview、■/➤/发送键三路径统一、handleEditorSubmitRef |
| `packages/ui/src/voiceAudio.ts` | 纯函数：downsampleLinear / float32ToInt16 / mergeFloat32Chunks |
| `packages/desktop/src/main/desktopVoiceCore.ts` | main 进程转写核心：whisper-cli spawn、段级时间戳解析、GLM fetch、encodeWav、analyzePcm16 静音检、buildWhisperArgs |
| `packages/desktop/src/main/desktopVoiceIpc.ts` | IPC handler：`voice:transcribe` |
| `packages/desktop/src/preload/index.ts` | contextBridge `window.zcode.voiceTranscribe` |
| `packages/desktop/src/main/index.ts` | `registerDesktopVoiceIpc()` 注册点 |
| `packages/desktop/electron-builder.config.js` | `NSMicrophoneUsageDescription` 打包声明 |

### CLI TUI（次级线）
| 文件 | 职责 |
|---|---|
| `apps/zcode-cli/packages/cli/src/voice-input.ts` | sox 录音 + 双 ASR（whisper/GLM）+ Silero VAD |
| `apps/zcode-cli/packages/cli/src/tui-voice-config.ts` | 读 voice.* 配置 |
| `apps/zcode-cli/packages/tui/src/app-voice-input.tsx` / `app-voice-text.ts` | TUI hook + 注入纯函数 |
| `apps/zcode-cli/docs/specs/voice-input.md` | spec |

### 配置 / 类型
- `apps/zcode-cli/packages/contracts/src/config/index.ts` → `RuntimeConfig.voice` + `ConfigKey.Voice`
- `apps/zcode-cli/packages/adapters/src/config/schema.ts` → `voiceSchema`（zod）

## 3. 数据流（renderer → main → ASR）

```
getUserMedia({ channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true })
  └─ AudioContext(实际 48k)
       ├─ MediaStreamSource
       │    ├─ ScriptProcessorNode(4096) → chunksRef: Float32Array[](原始 48k)
       │    └─ muteGain → destination（防外放，且 ScriptProcessor 需挂 destination 才持续回调）
       └─ AnalyserNode(fftSize 2048) → amplitude()（rAF 波形实时读）

preview 循环（composer 600ms tick，effect 依赖 voice.phase）：
  若 capturedSeconds - lastTranscribedEnd < 0.6 → skip
  否则 voice.transcribeAll()
    → buildFullPcm() = merge + downsampleLinear(48k→16k) + float32ToInt16
    → window.zcode.voiceTranscribe(pcm, 16000, TECH_WORDS_PROMPT)
    → main 写 wav → whisper-cli（spawn，>1 秒音频）→ 段数组
    → previewTextRef / previewCapturedAtRef 缓存，UI setVoicePreview

stop()（■/➤/发送键三路径统一）：
  返回 { previewText, finalize }
  previewText 立即 appendText 进输入框（原文保留，无清空感）
  finalize：若 previewCapturedAt >= capturedNow-1.2s → 沿用预览（零延迟）
           否则重新全量转写 → 与 preview 不同则原地 replace
  ➤ 路径：finalize 后 handleEditorSubmitRef（自动发送）
```

## 4. 生命周期与状态机

```
idle → recording → transcribing → idle
                ↘ （finalize 空结果 → 自动 openCapture 回 recording，emptyResult=true）
```

- **代次守卫**：`generationRef` 每次 start/stop/cancel/retake 自增，异步转写返回时代次不符即丢弃（彻底防「旧 session 结果覆盖新 session」）。
- **concurrency 上限**：`previewBusyRef` 保证同时至多 1 个 preview 转写在飞。
- **卸载清理**：`teardownCapture` + `useEffect(() => teardownCapture)` 保证关窗不留麦克风占用。

## 5. 已知性能瓶颈（重构动机）

1. **每段 spawn whisper-cli**：~0.3s 进程启动 + 模型 page-in，是蹦字延迟的主要来源。
2. **rolling 全量重转 O(n²)**：每 600ms 对 `audio[0:t]` 全量重转，t 增长则每轮变慢，>60s 明显劣化。
3. **whisper 中文口语天花板**：同音字/断句/技术词错误率不达产品预期（引擎层，非 bug）。
4. **线性插值重采样**：48k→16k 无 band-limited 抗混叠。
5. **技术词热表是常量**：无 workspace/conversation 动态上下文。

## 6. 可复用资产（重构不要扔）

- **静音三重防线**：renderer 波形 + `analyzePcm16`（RMS/peak/zeroRatio 全零判空）+ Silero VAD（`buildWhisperArgs` 里 `--vad -vm ... -vt 0.45 -vspd 180 -vsd 350 -vp 200`）。这些参数是已验证的 baseline。
- **段级时间戳**：`parseWhisperSegments` 正则已对 whisper-cli 输出（无 `-nt`）验证，是 future stable-prefix 合并的时间轴基础。
- **encodeWav / analyzePcm16 / buildWhisperArgs**：纯函数，有单测（desktopVoiceCore.test.ts 18/18）。
- **stop() 观感重构**：`{ previewText, finalize }` 接口 + 代次守卫 + 1.2s 新鲜度判定——成熟产品「原文保留、后台快速替换」的实现，值得沿用到新架构。
- **generation 计数 + previewBusy 限流 + useEffect(phase) 生命周期**：防竞态的已验证模式。
- **brew whisper.cpp 1.9.4 + silero v6.2.0**：VAD 模型版本配对是踩坑结论。

## 7. 潜在风险

- **native addon 打包**：未来 sherpa-onnx 若直接 require 进 main，存在 ASAR unpack / DYLD / ABI 风险（Electron ≠ Node ABI）。
- **责任进程连坐**：macOS 麦克风 TCC 判定向上溯责任 App——dev 实例必须由用户终端拉起，AI 会话起的实例永久全零（已实证的排障陷阱）。
- **authoritative final 与 preview 的 prompt 一致性**：两者必须带同一 prompt，否则标点风格分裂（已踩过）。
- **electron 二进制手动安装**：pnpm install 时 electron 未下载（install.js 静默跳过），重装需重新手动解压到 `node_modules/electron/dist/`。

## 8. 测试现状

- `packages/desktop/test/desktopVoiceCore.test.ts`：18/18（encodeWav、whisper 真机段解析、buildWhisperArgs、静音检、VAD 模型解析、配置读取）。
- `packages/ui/test/voiceAudio.test.ts`：7/7（重采样/整型化/合并）。
- `apps/zcode-cli/packages/{cli,tui}/test/`：16/16。
- 双侧 `pnpm run typecheck` 0 错；`oxlint` 0 error。
- 无自有 benchmark（真实中文/编程语音集）——这是本工程最高优先级补缺。