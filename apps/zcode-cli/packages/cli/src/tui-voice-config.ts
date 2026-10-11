import { createConfig } from "@zcode/adapters/config";
import type { RuntimeConfig } from "@zcode/contracts";
import type { GlobalOptions } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

type ResolveTuiVoiceConfigInput = {
  deps: RunDependencies;
  options: GlobalOptions;
  workingDirectory: string;
};

// TUI 的语音输入能力只在 CLI 边界装配一次；登录前本地面板阶段（ZCodeApp
// 尚未建立）也需要可用的 voice.* 配置，与 tui-startup-locale 同一模式。
export function resolveTuiVoiceConfig({
  deps,
  options,
  workingDirectory,
}: ResolveTuiVoiceConfigInput): RuntimeConfig["voice"] {
  const configResult = createConfig({
    env: deps.env ?? process.env,
    projectConfigPath: deps.projectConfigPath,
    skipUserConfig: deps.skipUserConfig,
    userConfigPath: deps.userConfigPath,
    workingDirectory,
  });
  return configResult.config.voice;
}
