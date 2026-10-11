# 已知问题（Known Issues）

## 功能/质量

1. **SenseVoice 静音幻觉**：纯静音输入输出韩文字符「그.」——已被上游静音防线
  （analyzePcm16）拦截，但若去掉防线会复现。
2. **SenseVoice 技术词错误率高**：postg SQL / cloth coat / kuubernet / thinks
  ——sherpa SenseVoice 不支持 hotword，技术词靠 LLM correction 层兜底（待接）。
3. **长录音 final 延迟线性增长**：whisper 全量重转 O(n)；已通过 preview 滚动
  窗口冻结（30s/2s overlap）消除 preview 侧劣化；final 侧仍整段（<1min 可接受）。
4. **「先错后对」修正观感**：rolling 重转对半截词先猜错后转对——rolling 机制
  固有，DSH/微信输入法同样存在；常驻化后修正延迟已大幅缩短。

## 环境/工程

5. **dev 实例必须用户终端启动**：macOS 麦克风 TCC「责任进程」连坐——AI 会话
  拉起的实例永久全零（误诊教训，详见 git log 诊断记录）。
6. **electron 二进制手动安装**：pnpm install 时 install.js 静默跳过下载；需手动
  从 npmmirror 拉 zip 解压到 `node_modules/electron/dist/`（Electron.app 必须在
  dist 下，path.txt 不能带换行）。
7. **嵌套 workspace（apps/zcode-cli）pnpm-lock 缺包**：上游 lockfile 缺 6 个根
  workspace 包；本地用符号链接（.git/info/exclude）修复，重装后需重做。
8. **Paraformer 模型不可得**：hf/hf-mirror/modelscope 全渠道失败（墙+404），
   PoC 挂起；provider 骨架已就绪。
9. **Linux RSS 测量未实现**：benchmark RSS 仅 macOS（/usr/bin/time -l）。
10. **打包态（SEA/packaged Electron）的 worker 路径**：dev 用源码相对路径；
    packaged 需将 sensevoice-worker.cjs / whisper 模型列入 ASAR unpack 与
    resources（打包 smoke 未做，见验收清单第 15 条）。
11. **sherpa-onnx-node 的 Electron 兼容**：worker 走 ELECTRON_RUN_AS_NODE=1
    的独立进程，N-API addon 不进 main 进程；打包态 ABI 风险由进程隔离兜底。

## 人工验收清单（待用户执行）

- [ ] 连续说 30s~2min 技术内容（Go/Nginx/PostgreSQL/K8s/readiness probe 示例句），
      观察边说边出字、无卡顿/跳字/吞字/重复，技术词正确率。
- [ ] 停止后 final 文本优于 preview 的比例。
- [ ] 完全静音/键盘声/风扇声各 10s：无幻觉文本。
- [ ] 录音中 kill whisper-server：自动恢复或 fallback，不丢语音输入功能。
