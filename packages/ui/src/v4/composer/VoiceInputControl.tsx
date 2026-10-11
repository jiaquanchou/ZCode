import { useEffect, useRef } from "react";
import { ArrowUpIcon, Loader2, MicIcon, SquareIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { VoiceRecordingController } from "./useVoiceRecording.js";

/**
 * 语音输入的展示件（交互对齐 DeepSeek 客户端）：
 * - VoiceMicButton：常驻提交区（发送键旁）的小入口；录音中变红色停止方块
 *   （再点一次=完成转写），转写中转圈。
 * - VoiceWaveform：SVG 电平历史，requestAnimationFrame 直接改线段几何
 *   （不经过 React state，对齐 DSH 的做法避免渲染抖动）；移位寄存器让最新
 *   电平在最右，静音时是点状基线，左淡右浓。
 * - VoiceRecordingPanel：录音条本体。左 ✕ 取消，中波形，右 ■ 完成转写 /
 *   ➤ 转写并发送；下方灰色 preview 区实时蹦字。
 *   空结果不退出录音：条内原地提示「未识别到语音」，继续说即可。
 */

export function VoiceMicButton({
  disabled,
  controller,
  onFinish,
  onStart,
}: {
  disabled?: boolean;
  controller: VoiceRecordingController;
  onFinish: () => void;
  onStart: () => void;
}) {
  const { intl } = useZCodeIntl();
  const recording = controller.phase === "recording";
  const transcribing = controller.phase === "transcribing";
  const title = recording
    ? intl.formatMessage(
        { id: "chat.composer.voice.tooltip.stop" },
        { seconds: controller.elapsedSeconds },
      )
    : controller.error === "mic-denied"
      ? intl.formatMessage({ id: "chat.composer.voice.micDenied" })
      : controller.error === "voice-unavailable"
        ? intl.formatMessage({ id: "chat.composer.voice.unavailable" })
        : controller.error
          ? intl.formatMessage({ id: "chat.composer.voice.failed" }, { message: controller.error })
          : intl.formatMessage({ id: "chat.composer.voice.tooltip.start" });

  if (!controller.available && controller.phase === "idle") {
    // 无桌面转写桥（web / 旧宿主）时不占位。
    return null;
  }

  return (
    <Button
      aria-label={title}
      data-testid="chat-composer-voice-button"
      disabled={disabled || transcribing}
      onClick={() => (recording ? onFinish() : onStart())}
      size="icon"
      title={title}
      type="button"
      variant="ghost"
      className={recording ? "text-red-500" : undefined}
    >
      {transcribing ? (
        <Loader2 aria-hidden className="size-4 animate-spin" />
      ) : recording ? (
        <SquareIcon aria-hidden className="size-4 fill-current" />
      ) : (
        <MicIcon aria-hidden className="size-4" />
      )}
    </Button>
  );
}

/** SVG 电平历史：80 根竖线，rAF 直接改 y1/y2，50ms 采样一次，移位寄存器左移。 */
const WAVEFORM_LINES = 80;
const WAVEFORM_SAMPLE_MS = 50;
const WAVEFORM_VIEW_WIDTH = 640;
const WAVEFORM_VIEW_HEIGHT = 40;
const WAVEFORM_CENTER = WAVEFORM_VIEW_HEIGHT / 2;
const WAVEFORM_MAX_AMPLITUDE_GAIN = 5;
const WAVEFORM_MAX_HEIGHT = 17;
const WAVEFORM_BASE_HEIGHT = 1;

export function VoiceWaveform({ controller }: { controller: VoiceRecordingController }) {
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const lines = Array.from(svgRef.current?.querySelectorAll("line") ?? []).reverse();
    const bars = lines.map((element) => ({ element, level: 0 }));
    let frame = 0;
    let previous = Number.NEGATIVE_INFINITY;
    const draw = (now: number) => {
      if (now - previous >= WAVEFORM_SAMPLE_MS) {
        previous = now;
        let next = controller.amplitude();
        for (const bar of bars) {
          const previousLevel = bar.level;
          bar.level = next;
          next = previousLevel;
          const height =
            WAVEFORM_BASE_HEIGHT +
            Math.min(1, bar.level * WAVEFORM_MAX_AMPLITUDE_GAIN) * WAVEFORM_MAX_HEIGHT;
          bar.element.setAttribute("y1", String(WAVEFORM_CENTER - height));
          bar.element.setAttribute("y2", String(WAVEFORM_CENTER + height));
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [controller]);
  return (
    <svg
      aria-hidden
      className="block h-6 min-w-6 flex-1 text-muted-foreground"
      preserveAspectRatio="none"
      ref={svgRef}
      viewBox={`0 0 ${WAVEFORM_VIEW_WIDTH} ${WAVEFORM_VIEW_HEIGHT}`}
    >
      {Array.from({ length: WAVEFORM_LINES }, (_, index) => (
        <line
          key={index}
          opacity={0.25 + index / 120}
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={3}
          x1={index * 8 + 4}
          x2={index * 8 + 4}
          y1={WAVEFORM_CENTER - 1}
          y2={WAVEFORM_CENTER + 1}
        />
      ))}
    </svg>
  );
}

export function VoiceRecordingPanel({
  controller,
  previewText,
  onCancel,
  onFinish,
  onFinishSend,
}: {
  controller: VoiceRecordingController;
  previewText: string;
  onCancel: () => void;
  onFinish: () => void;
  onFinishSend: () => void;
}) {
  const { intl } = useZCodeIntl();
  const recording = controller.phase === "recording";
  const transcribing = controller.phase === "transcribing";
  const emptyNotice = recording && controller.emptyResult;
  const finishLabel = intl.formatMessage({ id: "chat.composer.voice.finish" });
  const finishSendLabel = intl.formatMessage({ id: "chat.composer.voice.finishSend" });

  return (
    // 照抄 DeepSeek：录音条就是输入框底行本身——无描边、无阴影、无圆角卡片。
    <div className="flex flex-col" data-testid="chat-composer-voice-recording">
      {/* 预览区在工具行上方：录音条是输入框底部的 overlay，向下排会被裁掉；
          justify-end 让溢出时裁掉旧行、始终显示最新的几行。 */}
      {recording && previewText ? (
        <div
          aria-label={intl.formatMessage({ id: "chat.composer.voice.preview" })}
          aria-live="polite"
          className="flex max-h-[54px] flex-col justify-end overflow-hidden px-3 pb-0.5 text-xs leading-[18px] text-muted-foreground"
          role="log"
        >
          <span className="break-words">{previewText}</span>
        </div>
      ) : null}
      <div className="flex w-full items-center gap-1 bg-background px-1 py-1">
        {emptyNotice ? (
          // 空结果：提示文字在左、✕ 靠右——用户动线在发送键一侧，取消就近可点。
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {intl.formatMessage({ id: "chat.composer.voice.empty" })}
            </span>
            <Button
              aria-label={intl.formatMessage({ id: "chat.composer.voice.cancel" })}
              data-testid="chat-composer-voice-cancel"
              onClick={onCancel}
              size="icon"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button
              aria-label={intl.formatMessage({ id: "chat.composer.voice.cancel" })}
              data-testid="chat-composer-voice-cancel"
              disabled={transcribing}
              onClick={onCancel}
              size="icon"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden className="size-4" />
            </Button>
            {recording ? (
              <VoiceWaveform controller={controller} />
            ) : (
              <span className="min-w-0 flex-1" />
            )}
          </>
        )}
        {transcribing ? (
          <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            <Button
              aria-label={finishLabel}
              data-testid="chat-composer-voice-finish"
              onClick={onFinish}
              size="icon"
              title={finishLabel}
              type="button"
              variant="ghost"
            >
              <SquareIcon aria-hidden className="size-4 fill-current" />
            </Button>
            <Button
              aria-label={finishSendLabel}
              data-testid="chat-composer-voice-finish-send"
              onClick={onFinishSend}
              size="icon"
              title={finishSendLabel}
              type="button"
              variant="secondary"
              className="rounded-full bg-brand text-foreground-inverse hover:bg-brand/80"
            >
              <ArrowUpIcon aria-hidden className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
