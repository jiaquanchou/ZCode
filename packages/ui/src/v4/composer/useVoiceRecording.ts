import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  downsampleLinear,
  float32ToInt16,
  mergeFloat32Chunks,
  VOICE_TARGET_SAMPLE_RATE,
} from "@/voiceAudio.js";

/**
 * composer 语音录音控制器：管理 getUserMedia 采集、电平/计时状态与转写调用。
 * 转写经桌面 preload 桥 `window.zcode.voiceTranscribe`（PCM16 → 段数组）；
 * web/旧宿主无此桥时 `available` 为 false，UI 据此整体隐藏。
 *
 * 转写策略（rolling 全量重转，调研 P0）：每 600ms 对**全部已采集音频**重转
 * 一次（whisper 段级时间戳输出）。全量窗口 = 上下文 100% 完整，同音字/断句
 * 错误显著低于短段独立识别；同音频同参数的识别是确定性的，每轮全量重建
 * preview 无需跨窗文本对齐。M5 实测 20.7s 音频 warm 转写 0.84s，典型语音
 * 输入（≤30s）节奏可接受；超长录音（>1min）劣化，为已知限制。
 *
 * `stop()` 停止采集：同步返回已蹦出的预览文本（供「原文保留」），并触发
 * 后台权威转写（空串 = 未识别到语音）。
 * 空结果自动重新开麦并置 `emptyResult`（对齐 DeepSeek：提示留在条内）。
 */

export type VoiceTranscriptSegment = {
  /** 段起始（秒，相对录音起点）。 */
  start: number;
  end: number;
  text: string;
};

type DesktopVoiceTranscriber = (
  pcm16: Int16Array,
  sampleRate: number,
  prompt?: string,
) => Promise<VoiceTranscriptSegment[]>;

type DesktopBridgeWithVoice = {
  zcode?: { voiceTranscribe?: DesktopVoiceTranscriber };
};

const VOICE_PROCESSOR_BUFFER_SIZE = 4096;
/** 全量转写 prompt：技术词热表（动态项目词表为后续配置化预留）。 */
const VOICE_TECH_WORDS_PROMPT =
  "WebSocket、PostgreSQL、Kubernetes、GitLab、GitHub、TypeScript、JavaScript、Electron、whisper、sherpa-onnx、SenseVoice、Silero、API、MySQL、Redis、Docker、Nginx、Claude Code、MCP。";

function resolveDesktopVoiceTranscriber(): DesktopVoiceTranscriber | undefined {
  const bridge = (globalThis as { window?: DesktopBridgeWithVoice }).window;
  return bridge?.zcode?.voiceTranscribe;
}

export type VoiceRecordingPhase = "idle" | "recording" | "transcribing";

export type VoiceRecordingController = {
  available: boolean;
  phase: VoiceRecordingPhase;
  elapsedSeconds: number;
  error: string | null;
  emptyResult: boolean;
  start: () => Promise<void>;
  stop: () => { previewText: string; finalize: Promise<string> };
  cancel: () => void;
  retake: () => Promise<void>;
  /** 实时 RMS 电平（AnalyserNode 直读，供 rAF 波形任意帧率轮询）。 */
  amplitude: () => number;
  /** 已采集的音频秒数（采集时钟）。 */
  capturedSeconds: () => number;
  /** 对全部已采集音频做一次转写，返回段数组（start 相对录音起点）。 */
  transcribeAll: () => Promise<VoiceTranscriptSegment[]>;
  /** 全量转写是否正在飞行（同时至多一个）。 */
  previewBusy: () => boolean;
};

export function useVoiceRecording(): VoiceRecordingController {
  const [phase, setPhase] = useState<VoiceRecordingPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);
  const [available, setAvailable] = useState(false);
  const transcriberRef = useRef<DesktopVoiceTranscriber | undefined>(undefined);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const analyserSamplesRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const rawFramesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewBusyRef = useRef(false);
  // 取消/停止后丢弃过期预览响应的代次计数。
  const generationRef = useRef(0);
  // 最近一次全量预览的结果缓存：stop 时「原文保留」的数据来源。
  const previewTextRef = useRef("");
  const previewCapturedAtRef = useRef(0);

  useEffect(() => {
    transcriberRef.current = resolveDesktopVoiceTranscriber();
    setAvailable(Boolean(transcriberRef.current));
  }, []);

  const teardownCapture = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    analyserNodeRef.current = null;
    analyserSamplesRef.current = null;
    processorNodeRef.current?.disconnect();
    processorNodeRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    for (const track of mediaStreamRef.current?.getTracks() ?? []) track.stop();
    mediaStreamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
  }, []);

  // 卸载兜底：录音中途关窗/切换会话不留麦克风占用。
  useEffect(() => teardownCapture, [teardownCapture]);

  const openCapture = useCallback(
    async (transcriber: DesktopVoiceTranscriber): Promise<void> => {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        const audioContext = new AudioContext();
        mediaStreamRef.current = mediaStream;
        audioContextRef.current = audioContext;
        chunksRef.current = [];
        rawFramesRef.current = 0;
        const sourceNode = audioContext.createMediaStreamSource(mediaStream);
        const processorNode = audioContext.createScriptProcessor(VOICE_PROCESSOR_BUFFER_SIZE, 1, 1);
        sourceNodeRef.current = sourceNode;
        processorNodeRef.current = processorNode;
        // 实时电平 tap：AnalyserNode 独立于音频回调，供 rAF 波形以任意帧率读取。
        const analyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = 2048;
        analyserNodeRef.current = analyserNode;
        analyserSamplesRef.current = new Float32Array(analyserNode.fftSize);
        sourceNode.connect(analyserNode);
        processorNode.onaudioprocess = (event) => {
          const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
          chunksRef.current.push(chunk);
          rawFramesRef.current += chunk.length;
        };
        sourceNode.connect(processorNode);
        // ScriptProcessor 需要接到 destination 才会在部分 Chromium 版本持续回调；
        // 输出静音，避免采集声音外放。
        const muteGain = audioContext.createGain();
        muteGain.gain.value = 0;
        processorNode.connect(muteGain);
        muteGain.connect(audioContext.destination);
        setElapsedSeconds(0);
        setPhase("recording");
        timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1_000);
      } catch (cause) {
        teardownCapture();
        const name = cause instanceof DOMException ? cause.name : "";
        setError(
          name === "NotAllowedError" || name === "SecurityError" ? "mic-denied" : "start-failed",
        );
      }
    },
    [teardownCapture],
  );

  const start = useCallback(async () => {
    setError(null);
    setEmptyResult(false);
    generationRef.current += 1;
    const transcriber = transcriberRef.current;
    if (!transcriber) {
      setError("voice-unavailable");
      return;
    }
    await openCapture(transcriber);
  }, [openCapture]);

  /** 全量 PCM16（16k 重采样）。录音未开始/无样本返回 undefined。 */
  const buildFullPcm = useCallback((): Int16Array | undefined => {
    const inputSampleRate = audioContextRef.current?.sampleRate;
    const recorded = mergeFloat32Chunks(chunksRef.current);
    if (recorded.length === 0 || inputSampleRate === undefined) return undefined;
    return float32ToInt16(downsampleLinear(recorded, inputSampleRate, VOICE_TARGET_SAMPLE_RATE));
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    chunksRef.current = [];
    rawFramesRef.current = 0;
    teardownCapture();
    setPhase("idle");
    setElapsedSeconds(0);
    setEmptyResult(false);
  }, [teardownCapture]);

  const retake = useCallback(async () => {
    generationRef.current += 1;
    chunksRef.current = [];
    rawFramesRef.current = 0;
    teardownCapture();
    setEmptyResult(false);
    setError(null);
    const transcriber = transcriberRef.current;
    if (!transcriber) return;
    await openCapture(transcriber);
  }, [openCapture, teardownCapture]);

  const amplitude = useCallback((): number => {
    const analyser = analyserNodeRef.current;
    const samples = analyserSamplesRef.current;
    if (!analyser || !samples) return 0;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }, []);

  const capturedSeconds = useCallback((): number => {
    const rate = audioContextRef.current?.sampleRate;
    return rate === undefined ? 0 : rawFramesRef.current / rate;
  }, []);

  /**
   * 停止采集并进入确认阶段（对齐成熟产品「原文保留、后台快速替换」的观感）：
   * 同步返回当前已蹦出的预览文本（调用方立即搬进输入框，字不消失），
   * 同时触发后台权威转写。最后一次预览已覆盖停止前 1.2s 内音频时视为
   * 「所见即所得」，后台直接沿用预览文本（零延迟）；否则重转补全尾巴，
   * finalize 的结果与预览不同时由调用方原地替换。
   */
  const stop = useCallback((): { previewText: string; finalize: Promise<string> } => {
    const previewText = previewTextRef.current ?? "";
    const previewCapturedAt = previewCapturedAtRef.current ?? 0;
    const capturedNow = capturedSeconds();
    const fullPcm = buildFullPcm();
    teardownCapture();
    generationRef.current += 1;
    previewTextRef.current = "";
    previewCapturedAtRef.current = 0;
    setPhase("transcribing");
    let rearmed = false;
    const finalize = (async (): Promise<string> => {
      try {
        // 预览已覆盖到停止前 1.2s 内：蹦出的字就是最终结果，零延迟沿用。
        const previewIsFresh = previewCapturedAt >= capturedNow - 1.2;
        if (previewIsFresh || !fullPcm || fullPcm.length === 0) return previewText;
        // final 与 preview 带同一个 prompt：条件不一致会导致输出风格分裂
        // （preview 有标点、final 无标点——initial_prompt 显著影响输出风格）。
        const segments = await transcriberRef.current?.(
          fullPcm,
          VOICE_TARGET_SAMPLE_RATE,
          VOICE_TECH_WORDS_PROMPT,
        );
        const text = (segments ?? [])
          .map((segment) => segment.text)
          .join("")
          .trim();
        if (!text) {
          // 空结果不退出录音：提示留在条内，麦克风继续保持，用户直接重说。
          setEmptyResult(true);
          rearmed = true;
          const transcriber = transcriberRef.current;
          if (transcriber) await openCapture(transcriber);
          return previewText;
        }
        return text;
      } catch {
        // 权威转写失败时保住已蹦出的预览文本（比空输入框好）。
        return previewText;
      } finally {
        // 空结果已重新开麦（phase=recording），不能覆盖回 idle。
        if (!rearmed) setPhase("idle");
        setElapsedSeconds(0);
      }
    })();
    return { previewText, finalize };
  }, [buildFullPcm, capturedSeconds, openCapture, teardownCapture]);

  const transcribeAll = useCallback(async (): Promise<VoiceTranscriptSegment[]> => {
    const transcriber = transcriberRef.current;
    if (!transcriber || previewBusyRef.current) return [];
    const pcm = buildFullPcm();
    if (!pcm || pcm.length < 1_600) return [];
    previewBusyRef.current = true;
    const run = generationRef.current;
    try {
      const segments = await transcriber(pcm, VOICE_TARGET_SAMPLE_RATE, VOICE_TECH_WORDS_PROMPT);
      // 响应返回时录音已被取消/停止：过期预览直接丢弃。
      if (run !== generationRef.current) return [];
      previewTextRef.current = segments
        .map((segment) => segment.text)
        .join("")
        .trim();
      previewCapturedAtRef.current = pcm.length / VOICE_TARGET_SAMPLE_RATE;
      return segments;
    } catch {
      // 预览是临时性的：单轮失败静默丢弃，权威文本由最终整段转写给出。
      return [];
    } finally {
      previewBusyRef.current = false;
    }
  }, [buildFullPcm]);

  // 稳定引用：phase 等不变时保持同一对象，调用方的 useMemo 缓存才不会渲染旧状态。
  return useMemo(
    () => ({
      available,
      phase,
      elapsedSeconds,
      error,
      emptyResult,
      start,
      stop,
      cancel,
      retake,
      amplitude,
      capturedSeconds,
      transcribeAll,
      previewBusy: () => previewBusyRef.current,
    }),
    [
      available,
      phase,
      elapsedSeconds,
      error,
      emptyResult,
      start,
      stop,
      cancel,
      retake,
      amplitude,
      capturedSeconds,
      transcribeAll,
    ],
  );
}
