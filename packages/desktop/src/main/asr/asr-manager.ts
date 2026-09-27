/**
 * AsrManager：provider 选择 / 自动 fallback / 健康检查 / 简单指标。
 *
 * 规则（规格第十八节）：
 * - provider 按配置 asrProvider 解析；解析失败、health 失败或转写抛错时，
 *   **自动 fallback 到 whisper**（whisper 是永远保留的底）。
 * - fallback 只发生在 whisper 之外的 provider 上；whisper 自身错误直接抛给调用方。
 * - 单实例，desktop 主进程生命周期内常驻；由 registerDesktopVoiceIpc 组装。
 */
import { readDesktopVoiceConfig, type DesktopVoiceConfig } from "../desktopVoiceCore.js";
import { createGlmProvider } from "./glm-provider.js";
import { createWhisperProvider } from "./whisper-provider.js";
import { createWhisperResidentProvider } from "./whisper-resident-provider.js";
import {
  createSenseVoiceWorkerProvider,
  defaultWorkerModulePath,
} from "./sensevoice-worker-provider.js";
import type { AsrManagedResult, AsrProvider, AsrTranscribeOptions, AsrTranscribeResult } from "./types.js";

export class AsrManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsrManagerError";
  }
}

export type AsrManagerStats = {
  /** 各 provider 调用次数。 */
  calls: Record<string, number>;
  /** 各 provider 失败次数（含触发 fallback 的失败）。 */
  failures: Record<string, number>;
  fallbackCount: number;
  lastError?: string;
};

export class AsrManager {
  private readonly providers = new Map<string, AsrProvider>();
  private readonly fallbackProvider: AsrProvider;
  /** 配置的首选 provider id（whisper 场景解析为 whisper-resident）。 */
  private readonly preferredId: string;
  private stats: AsrManagerStats = { calls: {}, failures: {}, fallbackCount: 0 };

  private constructor(providers: AsrProvider[], fallbackProvider: AsrProvider, preferredId: string) {
    for (const provider of providers) this.providers.set(provider.id, provider);
    this.fallbackProvider = fallbackProvider;
    this.preferredId = preferredId;
  }

  /** 测试/扩展用：直接注入 provider 组与 fallback。 */
  static withProviders(
    providers: AsrProvider[],
    fallbackProvider: AsrProvider,
    preferredId?: string,
  ): AsrManager {
    return new AsrManager(providers, fallbackProvider, preferredId ?? fallbackProvider.id);
  }

  /** 组装 manager：按当前用户配置创建可用 provider，whisper spawn 恒为 fallback。 */
  static async create(config?: DesktopVoiceConfig): Promise<AsrManager> {
    const resolved = config ?? (await readDesktopVoiceConfig());
    const whisper = createWhisperProvider(resolved);
    const providers: AsrProvider[] = [];
    if (resolved.asrProvider === "glm") {
      const glm = createGlmProvider(resolved);
      if ((await glm.health()).ok) providers.push(glm);
      // glm 未配置 key 时不注册：fallback 自动落到 whisper
    } else {
      // 默认：常驻 whisper-server 首选（模型加载一次），spawn whisper 兜底
      // （whisper-server 缺失/崩溃超限时 AsrManager 自动 fallback）
      providers.push(createWhisperResidentProvider({ config: resolved, bin: resolved.whisperServerBin }));
    }
    // sensevoice：模型存在即注册（asrProvider=sensevoice 时为首选；
    // 质量对比期也可通过 provider 参数点名使用）。健康检查通过后入表。
    let preferredId = resolved.asrProvider === "glm" ? "glm" : "whisper-resident";
    if (resolved.asrProvider === "sensevoice" || resolved.asrProvider === "whisper-local" || resolved.asrProvider === "glm") {
      try {
        const sensevoice = createSenseVoiceWorkerProvider({
          config: resolved,
          workerModulePath: defaultWorkerModulePath(),
          threads: 4,
        });
        const sensevoiceHealth = await sensevoice.health();
        if (sensevoiceHealth.ok) {
          providers.push(sensevoice);
          if (resolved.asrProvider === "sensevoice") preferredId = "sensevoice";
        }
      } catch {
        // 模型缺失等：跳过注册，不影响其他 provider
      }
    }
    return new AsrManager(providers, whisper, preferredId);
  }

  get statsSnapshot(): AsrManagerStats {
    return { ...this.stats, calls: { ...this.stats.calls }, failures: { ...this.stats.failures } };
  }

  private recordCall(providerId: string): void {
    this.stats.calls[providerId] = (this.stats.calls[providerId] ?? 0) + 1;
  }

  private recordFailure(providerId: string, error: unknown): void {
    this.stats.failures[providerId] = (this.stats.failures[providerId] ?? 0) + 1;
    this.stats.lastError = error instanceof Error ? error.message : String(error);
  }

  /** 转写：优先用首选 provider，失败自动 fallback whisper（whisper 自身失败则抛）。 */
  async transcribe(options: AsrTranscribeOptions & { provider?: string }): Promise<AsrManagedResult> {
    const preferred = options.provider
      ? this.providers.get(options.provider)
      : this.providers.get(this.preferredId);

    if (!preferred) {
      return this.runWithFallback(options, undefined);
    }

    this.recordCall(preferred.id);
    try {
      const result = await preferred.transcribe(options);
      return { ...result, provider: preferred.id, fallbackUsed: false };
    } catch (error) {
      this.recordFailure(preferred.id, error);
      if (preferred.id === this.fallbackProvider.id) {
        // whisper 自身失败：直接抛给调用方，不再套 fallback 语义
        throw new AsrManagerError(`[asr:${preferred.id}] ${error instanceof Error ? error.message : String(error)}`);
      }
      return this.runWithFallback(options, error);
    }
  }

  private async runWithFallback(
    options: AsrTranscribeOptions & { provider?: string },
    primaryError: unknown,
  ): Promise<AsrManagedResult> {
    this.recordCall(this.fallbackProvider.id);
    this.stats.fallbackCount += 1;
    try {
      const result: AsrTranscribeResult = await this.fallbackProvider.transcribe(options);
      return {
        ...result,
        provider: this.fallbackProvider.id,
        fallbackUsed: true,
        primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
      };
    } catch (error) {
      this.recordFailure(this.fallbackProvider.id, error);
      throw new AsrManagerError(
        `[asr:${this.fallbackProvider.id}] ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 各 provider 健康检查汇总。 */
  async health(): Promise<Record<string, { ok: boolean; detail?: string }>> {
    const result: Record<string, { ok: boolean; detail?: string }> = {};
    for (const [id, provider] of this.providers) {
      result[id] = await provider.health();
    }
    result[this.fallbackProvider.id] = await this.fallbackProvider.health();
    return result;
  }

  async dispose(): Promise<void> {
    for (const provider of this.providers.values()) await provider.dispose().catch(() => undefined);
    await this.fallbackProvider.dispose().catch(() => undefined);
  }
}
