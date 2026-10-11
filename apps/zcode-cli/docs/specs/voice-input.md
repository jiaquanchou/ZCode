# Voice Input（语音输入）Spec

TUI 输入框语音输入：快捷键切换录音，停止后本地/云端 ASR 转写，转写文本注入输入框光标处（不自动提交）。

**桌面 App（GUI）版**（2026-09-27 同日补充）：composer 工具栏麦克风按钮（`packages/ui/src/v4/composer/VoiceInputControl.tsx`，leadingActions 插槽渲染），采集走 renderer `getUserMedia` + ScriptProcessorNode（`packages/ui/src/voiceAudio.ts` 重采样/整型化），PCM16 经 preload 桥 `window.zcode.voiceTranscribe` 送主进程（`packages/desktop/src/main/desktopVoiceCore.ts`：encodeWav → whisper-cli / GLM ASR），文本经 `LexicalChatInputHandle.appendText` 追加进编辑器。配置与 CLI 版共用 `~/.zcode/cli/config.json` 的 `voice` 段。web 端无桥不渲染按钮。macOS 需 `NSMicrophoneUsageDescription`（打包经 electron-builder extendInfo 携带；dev 模式需给 node_modules 的 Electron.app 注入，见 ~/opt/scratch/zcode-voice/fix-electron-mic-plist.sh）。

## 产品规则

- 热键 `Ctrl+G`：idle → 开始录音；recording → 停止并转写；transcribing → 忽略按键。只读视图（subagent 面板）与审批/选择面板激活时热键不生效（沿用全局键盘短路顺序）。
- 转写文本 `insertText` 进编辑器光标处，同步 `setDraftValue`，焦点回到输入框；**不自动 submit**。空转写结果不改动草稿。
- 录音有转写前状态行提示（输入框 composer 状态行最左）：`● 录音中 Ns` / `◌ 转写中`，随 locale 文案。
- 系统级能力（录音进程、ASR 调用）由 CLI 宿主通过 `TuiOptions.voiceInput` 注入；TUI 未收到该能力时热键提示「当前终端不支持语音输入」。TUI 不感知 sox/whisper/GLM 细节。

## 状态归属

- TUI：`phase`（idle/recording/transcribing，临时交互态，属 TUI 层）、会话控制器 ref、计时器。
- 宿主（cli）：录音子进程生命周期、音频临时文件、转写调用。进程/文件/网络 I/O 全部收敛在 `packages/cli/src/voice-input.ts`（与 clipboard-image 同层的入口能力实现）。
- 配置：`voice.*` 进 RuntimeConfig（contracts 默认值 + adapters schema 校验 + `~/.zcode/cli/config.json` 用户配置，优先级沿用 config-factory 链）。

## 接口

```ts
// tui
type TuiVoiceSession = { stop(): Promise<string>; cancel(): Promise<void> };
type TuiVoiceInput = { beginSession(): Promise<TuiVoiceSession> };
// TuiOptions.voiceInput?: TuiVoiceInput
```

```jsonc
// ~/.zcode/cli/config.json
{
  "voice": {
    "asrProvider": "whisper-local",          // "whisper-local" | "glm"
    "language": "zh",                          // whisper 转写语言（BCP-47 主子标签）
    "soxBin": "sox",                           // 录音二进制（跨平台由用户安装）
    "whisperBin": "whisper-cli",               // whisper.cpp CLI
    "whisperModelPath": "/path/to/ggml-*.bin", // whisper-local 必填
    "glmApiKey": "...",                        // glm 必填；勿写入日志/文档
    "glmBaseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "glmModel": "glm-asr"
  }
}
```

## 错误形态

`VoiceInputError`，`code: "not_configured" | "start_failed" | "transcribe_failed" | "unsupported"`。宿主抛出，TUI 捕获后转状态行文案（i18n）+ 截断的原始原因。不吞错、不用错误文本做流程判断。录音启动快速失败（进程即刻退出，如无麦克风权限/缺二进制）→ `start_failed`，原始 stderr 摘要随消息给出。临时音频文件在 finally 清理。

## 验收场景

1. whisper-local 已配置模型 + sox 就绪：Ctrl+G 开始 → 状态行出现录音提示 → 说话 → Ctrl+G → 状态行转写提示 → 文本落在输入框光标处，可继续编辑。
2. 未配置 `voice.whisperModelPath`：Ctrl+G → 状态行 not_configured 提示（含配置键名）。
3. 终端未注入 voiceInput 能力：提示不支持。
4. 录音中再按 Ctrl+G 但转写失败：状态行 transcribe_failed + 原因；草稿不变。
5. 空转写：提示未识别到语音，草稿不变。
6. 程序退出/组件卸载时存在活动录音会话：cancel，不留孤儿 sox 进程。

## 跨平台与限制

- 录音/转写二进制（sox、whisper-cli）由用户自行安装并可用 PATH/配置解析；Windows 注意 `.exe` 解析与 PATH（spawn 参数数组形式，不经 shell）。GLM 路径纯 Node fetch（18+ 全局 FormData/Blob），无平台依赖。
- 麦克风权限由宿主终端 App 承担（macOS 首次使用弹授权），失败归入 `start_failed`。
- 不支持按住说话（keyup 依赖增强键盘协议，后续再评估）；热键暂不可配置。桌面 App 是独立 React UI，本 spec 只覆盖 TUI。
- whisper 对纯静音长录音可能输出幻觉文本（如字幕组样式句子），MVP 不做 VAD/静音检测，后续可在转写后加置信度过滤或 `--entropy-thold` 评估。

## 2026-09-27 本机实测（M5 / macOS，large-v3-turbo q5_0 + Metal）

- 合成中文语音 20.7s（say/sox 16k mono wav）：转写正确率仅一处同音字差异（登录→登陆），自动句读；warm 转写耗时 0.84s（约 24× 实时；首次冷启动 20s 为模型 page-in + Metal 管线首编）。
- `sox -d` 实录 3s：92KB 标准 RIFF/PCM 16k mono wav，SIGINT 收尾退出码 0。
- 单测 16/16 通过（tui 纯函数 7 + cli 宿主 fake 场景 9，含错误路径与 cancel 幂等）；`pnpm run typecheck`（apps/zcode-cli）35/35。

## 2026-09-27 晚：静音幻觉根治与交互升级（P0+P1，GUI 为主）

背景：真机冒烟发现静音/低电平录音稳定产出幻觉文本（「优优独播剧场——YoYo Television Series Exclusive」类字幕水印句）——Whisper 对无语音音频的自回归幻觉，属 pipeline 缺 VAD，非引擎不适合（经 ChatGPT 调研 + DSH 源码交叉确认，Cursor 2026 为整段+batch STT 样板）。

三层防线（GUI 主进程 `desktopVoiceCore.ts`，CLI `voice-input.ts` 同步 ③）：
1. renderer 实时波形（`VoiceInputControl` 采集块 RMS，极低电平归零）——用户能看见有没有声音；
2. PCM 健康预检 `analyzePcm16`（rms/peak/zeroRatio）：全零/极低电平直接判空，不进 ASR；
3. whisper-cli 启用内置 Silero VAD（`--vad -vm ggml-silero-v6.2.0.bin -vt 0.45 -vspd 180 -vsd 350 -vp 200`；模型自动探测 whisper 模型同目录，或 `voice.vadModelPath` 显式配置）。实测对照：静音录音无 VAD 稳定幻觉、带 VAD 输出为空；真语音带 VAD 转写不受影响。注意 brew whisper.cpp 1.9.4 需配 silero **v6.2.0**（v5.1.2 会让真语音也被拒空）。

交互升级（2026-09-27 深夜二轮，按用户提供的 DeepSeek 客户端截图对齐）：录音条**停靠在输入框底部整行**（不再悬浮居中、不进按钮簇）——左 ✕ 取消，中**点阵波形**（24 点，音量点亮/变红），右三钮：🎤 重录 / ■ 完成转写进输入框 / **➤ 蓝色圆=转写并发送**（与提交区发送键同语义，停止→转写→appendText→handleEditorSubmit(getMarkdown())）。麦克风入口常驻发送键旁（录音中变红方块=完成转写）。**空结果不退出录音**：条内原地提示「未识别到语音」并自动重新开麦（DeepSeek 同款），用户直接继续说。教训沉淀：录音 UI 不进按钮簇（挤跑模型选择器）；「点波形完成」不可发现，必须显式按钮；hook 返回对象必须 useMemo 否则调用方 memo 缓存旧 state。

**五轮：波形与流式蹦字对齐 DSH 源码实现**（2026-09-27 深夜，用户确认麦克风恢复后提出两点：点阵效果不像、要「边说边把字蹦出来」。读 DSH `client-ui-voice-input` 源码后移植）：
- 波形：`VoiceWaveform.tsx` —— SVG 80 竖线（viewBox 640×40、preserveAspectRatio none、strokeWidth 3 圆头），`requestAnimationFrame` 直接改 y1/y2（**不经过 React state**，消除渲染抖动），50ms 采样，移位寄存器最新电平在最右，高度 `1+min(1,level*5)*17`（静音=2px 点状基线），透明度 `0.25+index/120` 左淡右浓；电平来源为 **AnalyserNode**（fftSize 2048，独立于音频回调任意帧率读取）。
- 蹦字：`voicePreviewSegmenter.ts`（RMS 预览分段器，**参数对齐 DSH 最新版**：threshold 0.012 / **silence 0.2s / heartbeat 2s** / leadIn 0.15s / tail 0.1s / overlap 0.3s / minSegment 0.3s——静音落刀不切词、心跳落刀带重叠）+ composer 100ms tick + `transcribeSegment()`（段切片→16k 重采样→复用 voiceTranscribe 桥，previewBusy 限流至多一个在飞，generation 计数丢弃取消后的过期响应）+ **`dedupeHead()` 裁掉心跳 overlap 造成的开头重复**（与 DSH 同款拼接语义：merged 为空则跳过）→ 灰色 preview 区实时拼接蹦字（aria-live polite，位于工具行**上方**、max-h 54px justify-end 裁旧留新——overlay 向下排会被输入框裁掉，这是踩过的坑）。**权威语义**：停止后的整段转写才写入输入框，preview 只是过程展示，单段失败静默丢弃。
- 已知限制：whisper 路径每段 spawn 进程 + 模型 page-in（~0.5s），蹦字延迟约 0.5~1s/段；DSH 用常驻 SenseVoice worker（RTF 0.015）所以更快。后续可 whisper-server 常驻化消除加载开销。
- 环境结论（重要）：**麦克风全零事件根因 = 责任进程链**。macOS 把麦克风授权判定绑定到启动链的责任 App：用户终端起的 dev（责任=App 自身）一切正常；AI 从会话起的一切进程（含 sox/Electron 测试）责任 App 是正式版 ZCode（无授权）→ 静默全零。此前 coreaudiod/TCC/增益方向全是误诊。**纪律：dev 实例由用户终端启动；语音恢复验证必须走用户终端。**

**六轮 P0（2026-09-27 深夜，按用户调研定案实施）：rolling 全量重转 + initial_prompt**。核心认知：识别错误多的根因是**短段（0.3~1s）独立转写丢失上下文**，不是 q5 精度问题。
- **蹦字改为 rolling 全量重转**：每 600ms 对**全部已采集音频**重转一次，preview = 全部段拼接。全量窗口 = 上下文 100% 完整，同音字/断句/技术词错误显著下降；同音频同参数识别是确定性的，每轮全量重建 preview **无需跨窗文本对齐**——RMS 分段器、dedupeHead、窗口队列由此整体退役（`voicePreviewSegmenter.ts` 删除）。节奏保护：音频增量 <0.6s 不转写；previewBusy 限流至多一个在飞；transcribeSegment 退役改 transcribeAll。
- **段级时间戳输出**：whisper args 去掉 `-nt`，stdout 段行 `[hh:mm:ss.mmm --> hh:mm:ss.mmm] text` 由 `parseWhisperSegments` 解析（desktopVoiceCore）；IPC `voice:transcribe` 返回段数组（GLM 包装为覆盖全 wav 的单段）；preload 桥签名 `(pcm16, sampleRate, prompt?)`。
- **initial_prompt**：`--prompt` 注入技术词热表（WebSocket/PostgreSQL/Kubernetes/MCP 等常量；动态项目词表预留配置化）。全量转写自带全部前文上下文，无需再注入前文。
- **final/preview 分离保持**：停止后整段权威转写写输入框；LLM 后纠错（P1）待办——桌面 main 无现成 GLM 凭据通道，需先解决授权链。
- 已知限制：全量转写时间随录音长度线性增长（30s≈0.84s，60s≈1.7s），蹦字节奏 >1min 后变慢；后续优化项 = 常驻 worker + 滚动窗口（P2 引擎 PoC 一并）。自建 benchmark（P0-3）暂以合成 say 音频 smoke 替代，真实语音集待录。
- P1/P2/P3 按调研方案挂起：LLM 纠错、高质量重采样（soxr/OfflineAudioContext 替代线性插值）、SenseVoice/Paraformer PoC、q5→f16（不做）。
