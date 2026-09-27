/**
 * ASR benchmark runner。
 *
 * 用法（仓库根执行，tsx 复用根 node_modules）：
 *   node_modules/.bin/tsx tools/asr-benchmark/src/runner.ts \
 *     --provider whisper \
 *     --refs tools/asr-benchmark/references.jsonl \
 *     --audio-dir tools/asr-benchmark/audio \
 *     --out tools/asr-benchmark/results [--vad] [--prompt "..."]
 *
 * 输出：results/<provider>.json（完整度量）、results/<provider>.csv、
 *       多 provider 跑完后 comparison.md / comparison.csv（可对比时自动生成）。
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWhisperProvider } from "./providers/whisper.js";
import type { AsrBenchmarkProvider } from "./providers/provider.js";
import type { ProviderBenchmark, ReferenceItem, SampleMetrics } from "./types.js";
import { computeCer, computeTermMetrics, mean, percentile } from "./metrics.js";

const WHISPER_BIN = process.env.WHISPER_BIN ?? "whisper-cli";
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ??
  "/Users/enhanced/opt/scratch/zcode-voice/models/ggml-large-v3-turbo-q5_0.bin";
const WHISPER_VAD =
  process.env.WHISPER_VAD ?? "/Users/enhanced/opt/scratch/zcode-voice/models/ggml-silero-v6.2.0.bin";

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args[key] = value;
        index += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

/** 读 wav 头取时长（秒）。 */
export async function wavDurationSeconds(wavPath: string): Promise<number> {
  const handle = await readFile(wavPath);
  if (handle.length < 44) return 0;
  const bitDepth = handle.readUInt16LE(34) || 16;
  const sampleRate = handle.readUInt32LE(24);
  const dataSize = handle.readUInt32LE(40);
  const bytesPerSample = bitDepth / 8;
  const bytesPerSecond = sampleRate * bytesPerSample; // mono
  return bytesPerSecond > 0 ? dataSize / bytesPerSecond : 0;
}

async function createProvider(name: string, args: Record<string, string | boolean>): Promise<AsrBenchmarkProvider> {
  switch (name) {
    case "whisper":
      return createWhisperProvider({
        bin: WHISPER_BIN,
        modelPath: WHISPER_MODEL,
        vadModelPath: args.vad ? WHISPER_VAD : undefined,
        language: "zh",
        threads: 8,
        segmentTimestamps: true,
      });
    case "sensevoice": {
      const { createSenseVoiceBenchmarkProvider } = await import("./providers/sensevoice.js");
      return createSenseVoiceBenchmarkProvider({
        modelDir: process.env.SENSEVOICE_MODEL_DIR ?? "/Users/enhanced/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx",
        workerModulePath: "/Users/enhanced/code/opensource/ZCode/packages/desktop/src/main/asr/sensevoice-worker.cjs",
        threads: 4,
        useItn: true,
      });
    }
    case "paraformer": {
      const { createParaformerBenchmarkProvider } = await import("./providers/paraformer.js");
      return createParaformerBenchmarkProvider({
        modelDir: process.env.PARAFORMER_MODEL_DIR ?? "/Users/enhanced/opt/scratch/zcode-voice/models/paraformer-zh",
        workerModulePath: "/Users/enhanced/code/opensource/ZCode/packages/desktop/src/main/asr/sensevoice-worker.cjs",
        threads: 4,
        hotwordsFile: (args.hotwords as string) || undefined,
        hotwordsScore: args["hotwords-score"] ? Number(args["hotwords-score"]) : 1.5,
      });
    }
    default:
      throw new Error(`未知 provider: ${name}`);
  }
}

export async function run(
  providerName: string,
  refsPath: string,
  audioDir: string,
  outDir: string,
  args: Record<string, string | boolean>,
): Promise<ProviderBenchmark> {
  const provider = await createProvider(providerName, args);
  const refs: ReferenceItem[] = [];
  const refsRaw = await readFile(refsPath, "utf8");
  for (const line of refsRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    refs.push(JSON.parse(trimmed) as ReferenceItem);
  }

  await mkdir(outDir, { recursive: true });
  const samples: SampleMetrics[] = [];
  let coldStartSeconds = 0;

  for (const ref of refs) {
    const wavPath = resolve(audioDir, ref.audio);
    const audioSeconds = ref.durationSeconds ?? (await wavDurationSeconds(wavPath));
    const output = await provider.transcribe({
      wavPath,
      audioSeconds,
      category: ref.category,
      prompt: typeof args.prompt === "string" ? args.prompt : undefined,
    });
    if (samples.length === 0) coldStartSeconds = output.wallSeconds;

    const cer = computeCer(ref.text, output.text);
    const terms = computeTermMetrics(ref.terms, output.text);

    samples.push({
      id: ref.id,
      category: ref.category,
      hypothesis: output.text,
      reference: ref.text,
      rawCer: cer.rawCer,
      normalizedCer: cer.normalizedCer,
      editDistance: cer.editDistance,
      referenceLength: cer.referenceLength,
      referenceTerms: ref.terms,
      hitTerms: terms.hitTerms,
      missedTerms: terms.missedTerms,
      recognizedTerms: terms.recognizedTerms,
      hypothesisTerms: terms.hypothesisTerms,
      technicalTermPrecision: terms.precision,
      audioSeconds,
      inferenceSeconds: output.inferenceSeconds,
      wallSeconds: output.wallSeconds,
      rtf: audioSeconds > 0 ? output.inferenceSeconds / audioSeconds : 0,
      rssMb: output.rssMb,
      peakRssMb: output.peakRssMb,
    });
    // 单条进度
    console.info(
      `[${providerName}] ${ref.id} ${ref.category} cer=${cer.normalizedCer.toFixed(3)} ` +
        `rtf=${(audioSeconds > 0 ? output.inferenceSeconds / audioSeconds : 0).toFixed(3)} ` +
        `hit=${terms.hitTerms.length}/${ref.terms.length}`,
    );
  }

  const normalizedCers = samples.map((sample) => sample.normalizedCer);
  const rawCers = samples.map((sample) => sample.rawCer);
  const wallSeconds = samples.map((sample) => sample.wallSeconds);
  const inferenceSeconds = samples.map((sample) => sample.inferenceSeconds);
  const rssValues = samples.map((sample) => sample.rssMb).filter((value) => value > 0);

  const byCategory: ProviderBenchmark["byCategory"] = {};
  for (const category of new Set(samples.map((sample) => sample.category))) {
    const group = samples.filter((sample) => sample.category === category);
    const hitTerms = group.reduce((sum, sample) => sum + sample.hitTerms.length, 0);
    const totalTerms = group.reduce((sum, sample) => sum + sample.referenceTerms.length, 0);
    const precisions = group.map((sample) => sample.technicalTermPrecision);
    byCategory[category] = {
      count: group.length,
      rawCer: mean(group.map((sample) => sample.rawCer)),
      normalizedCer: mean(group.map((sample) => sample.normalizedCer)),
      technicalTermRecall: totalTerms > 0 ? hitTerms / totalTerms : 0,
      technicalTermPrecision: mean(precisions),
    };
  }

  const hitTerms = samples.reduce((sum, sample) => sum + sample.hitTerms.length, 0);
  const totalTerms = samples.reduce((sum, sample) => sum + sample.referenceTerms.length, 0);
  const precisionList = samples.map((sample) => sample.technicalTermPrecision);

  const benchmark: ProviderBenchmark = {
    provider: provider.name,
    engine: provider.engine,
    generatedAt: new Date().toISOString(),
    counts: {
      total: samples.length,
      ...Object.fromEntries(Object.entries(byCategory).map(([key, value]) => [key, value.count])),
    },
    samples,
    aggregate: {
      rawCer: mean(rawCers),
      normalizedCer: mean(normalizedCers),
      technicalTermRecall: totalTerms > 0 ? hitTerms / totalTerms : 0,
      technicalTermPrecision: precisionList.length > 0 ? mean(precisionList) : 0,
      latencyP50: percentile(wallSeconds, 50),
      latencyP95: percentile(wallSeconds, 95),
      meanRtf: mean(samples.map((sample) => sample.rtf)),
      meanRssMb: rssValues.length > 0 ? mean(rssValues) : 0,
      peakRssMb: rssValues.length > 0 ? Math.max(...rssValues) : 0,
      coldStartSeconds,
      warmInferenceSeconds: mean(inferenceSeconds),
    },
    byCategory,
  };

  const jsonPath = join(outDir, `${provider.name}.json`);
  const csvPath = join(outDir, `${provider.name}.csv`);
  await writeFile(jsonPath, JSON.stringify(benchmark, null, 2), "utf8");
  await writeFile(
    csvPath,
    ["id,category,normalizedCer,rawCer,rtf,inferenceSeconds,wallSeconds,termRecall", ...samples.map((sample) =>
      [sample.id, sample.category, sample.normalizedCer, sample.rawCer, sample.rtf, sample.inferenceSeconds, sample.wallSeconds,
        `${sample.hitTerms.length}/${sample.referenceTerms.length}`].join(","),
    )].join("\n"),
    "utf8",
  );

  await provider.dispose().catch(() => undefined);
  console.info(`\n[${provider.name}] 完成：${samples.length} 条 → ${jsonPath}`);
  const agg = benchmark.aggregate;
  console.info(
    `  normalizedCER=${agg.normalizedCer.toFixed(4)} rawCER=${agg.rawCer.toFixed(4)} ` +
      `termRecall=${agg.technicalTermRecall.toFixed(3)} termPrecision=${agg.technicalTermPrecision.toFixed(3)} ` +
      `P50=${agg.latencyP50.toFixed(2)}s P95=${agg.latencyP95.toFixed(2)}s RTF=${agg.meanRtf.toFixed(3)} ` +
      `peakRSS=${agg.peakRssMb.toFixed(0)}MB cold=${agg.coldStartSeconds.toFixed(2)}s`,
  );
  return benchmark;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const providerName = (args.provider as string) ?? "whisper";
  const refsPath = resolve((args.refs as string) ?? "tools/asr-benchmark/references.jsonl");
  const audioDir = resolve((args["audio-dir"] as string) ?? "tools/asr-benchmark/audio");
  const outDir = resolve((args.out as string) ?? "tools/asr-benchmark/results");
  await run(providerName, refsPath, audioDir, outDir, args);

  // 生成 comparison（若存在多个 provider 结果）
  const files = await readdir(outDir).catch(() => [] as string[]);
  const providerDirs = files.filter((file) => /^[a-z-]+\\.json$/u.test(file) && file !== "comparison.json");
  if (providerDirs.length >= 2) {
    const providers: ProviderBenchmark[] = [];
    for (const file of providerDirs) {
      providers.push(JSON.parse(await readFile(join(outDir, file), "utf8")) as ProviderBenchmark);
    }
    await writeComparison(providers, outDir);
  }
}

export async function writeComparison(
  providers: readonly ProviderBenchmark[],
  outDir: string,
): Promise<void> {
  const rows = providers.map((benchmark) => {
    const agg = benchmark.aggregate;
    return [
      benchmark.provider,
      agg.normalizedCer.toFixed(4),
      agg.rawCer.toFixed(4),
      agg.technicalTermRecall.toFixed(3),
      agg.technicalTermPrecision.toFixed(3),
      agg.latencyP50.toFixed(2),
      agg.latencyP95.toFixed(2),
      agg.meanRtf.toFixed(3),
      agg.peakRssMb.toFixed(0),
      agg.coldStartSeconds.toFixed(2),
      agg.warmInferenceSeconds.toFixed(3),
      String(benchmark.counts.total ?? 0),
    ].join(",");
  });
  const header = "provider,normalizedCer,rawCer,termRecall,termPrecision,P50,P95,RTF,peakRssMB,coldStartS,warmInfS,samples";
  await writeFile(join(outDir, "comparison.csv"), [header, ...rows].join("\n"), "utf8");

  const lines = [
    "# ASR 引擎对比",
    "",
    "> 同批音频横评；数据不足时结论仅为初步。",
    "",
    "| provider | normCER | rawCER | termRecall | termPrecision | P50(s) | P95(s) | RTF | peakRSS(MB) | cold(s) | warmInf(s) | n |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const benchmark of providers) {
    const agg = benchmark.aggregate;
    lines.push(
      `| ${benchmark.provider} | ${agg.normalizedCer.toFixed(4)} | ${agg.rawCer.toFixed(4)} | ` +
        `${agg.technicalTermRecall.toFixed(3)} | ${agg.technicalTermPrecision.toFixed(3)} | ` +
        `${agg.latencyP50.toFixed(2)} | ${agg.latencyP95.toFixed(2)} | ${agg.meanRtf.toFixed(3)} | ` +
        `${agg.peakRssMb.toFixed(0)} | ${agg.coldStartSeconds.toFixed(2)} | ${agg.warmInferenceSeconds.toFixed(3)} | ${benchmark.counts.total ?? 0} |`,
    );
  }
  await writeFile(join(outDir, "comparison.md"), lines.join("\n"), "utf8");
}

// main 在直接执行时运行（tsx 单文件）；被测试 import 时不自动跑。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
