# 个人 Fork 与 ASR 开发说明

> 本文档说明本 Fork 的来源、个人改动范围与研发现状。上游项目的功能、架构与贡献指南以官方 README 与文档为准，本文不重复其内容。

## 上游来源与版权归属

- 本仓库是 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）的 Fork。
- 上游的 Agent harness、桌面端、CLI、Web 等全部基础能力均为上游成果；本 Fork 的改动范围仅限下文列出的语音输入/ASR 模块与配套文档。
- 同步基线：`feat/asr-engine-optimization` 分支自上游 v3.14.3（`29628c9a`）；Fork 的 `main` 分支保持与上游 `main` 同步（当前 v3.15.1，`aac47556`）。

## 个人开发目标

给 ZCode 补一套**本地优先、高质量、可插拔**的语音输入能力：从"能输入"到"技术内容输入可用"——重点关注 ASR 引擎横评选型、实时转写预览体验、长录音性能与静音幻觉防线。

## 改动模块与功能范围（相对上游 v3.14.3，共 78 个文件）

| 模块 | 内容 |
|---|---|
| `packages/desktop/src/main/asr/`（9 文件） | **AsrProvider/AsrManager 引擎抽象**：whisper（spawn CLI，恒为 fallback 底座）、whisper-resident（常驻 whisper-server，模型加载一次+崩溃重启限流）、glm（GLM API）、sensevoice（SenseVoiceSmall 常驻 worker，spawn+二进制帧协议）四引擎可插拔；健康检查、自动 fallback、调用/失败计数；restricted LLM correction（edit ops 校验+fail-open） |
| `packages/desktop/src/main/desktopVoiceCore.ts` | 三重静音防线：PCM RMS/零比率预检 → Silero VAD（ggml-silero v6.2.0，阈值 0.45 / min-speech 180ms / min-silence 350ms / pad 200ms）→ 编程场景 prompt 折中 |
| `packages/ui/src/v4/composer/useVoiceRecording.ts` | **rolling 全量重转预览**：每 600ms 对全部已采集音频重转（上下文 100% 完整，同音字/断句/技术词错误显著下降）；第八阶段滚动窗口冻结（30s 窗口/2s overlap），final 零延迟沿用预览 |
| `apps/zcode-cli`（TUI/CLI） | Ctrl+G 录音、蹦字预览、whisper/GLM 双后端配置 |
| `tools/asr-benchmark/` | ASR 引擎横评框架：whisper vs sensevoice 首轮结论（whisper+prompt 质量优、SenseVoice 仅速度优） |
| `docs/asr/`（6 篇） | 架构勘察/目标架构/benchmark 方法论/引擎对比/最终决策/已知问题 |

测试：`asr-manager.test.ts`（fallback 语义 6 用例）、`voice-input.test.ts`、`desktopVoiceCore.test.ts`、`sensevoice-worker.test.ts`。

## 构建、运行与验证

```bash
# 环境：Node 24.14.0 + pnpm 10.33.2（以 mise.toml 为准）
pnpm install --frozen-lockfile
pnpm typecheck          # tsc -b 多包
pnpm lint               # oxlint
pnpm dev:desktop        # 桌面端开发（ASR 改动主要在 packages/desktop）

# 已知环境坑（详见 docs/asr/known-issues.md）：
# - dev 实例必须用户终端启动（macOS 麦克风 TCC 责任进程连坐）
# - electron 二进制可能需手动从 npmmirror 拉取解压
```

## 当前限制（摘自 docs/asr/known-issues.md，共 11 条）

1. SenseVoice 纯静音幻觉（已被静音防线拦截，去防线复现）
2. SenseVoice 技术词错误率高，依赖 LLM correction 兜底（待接）
3. 长录音 final 延迟线性增长（whisper 全量重转 O(n)；preview 侧已由滚动窗口消除，final <1min 可接受）
4. Paraformer 模型全渠道不可得，PoC 挂起（provider 骨架就绪）
5. 打包态（packaged Electron）worker 路径与 ASAR unpack 未做 smoke

## 如何同步上游

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main   # main 严格跟随上游
# 个人开发线：
git checkout feat/asr-engine-optimization
git rebase main        # 或 merge，视冲突情况；禁止 force push 共享分支
```

## 后续研发计划

- LLM correction 接入 SenseVoice 首选链路（技术词兜底）
- final 转写滚动窗口化（消除 O(n) 长录音延迟）
- Paraformer 引擎 PoC（模型可得后）
- 打包态 ASAR/resources 布局与打包 smoke（验收清单第 15 条）
- benchmark 补 Linux RSS 测量与真实语音集
