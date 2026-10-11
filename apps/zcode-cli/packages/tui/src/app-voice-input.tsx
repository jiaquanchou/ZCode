import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { PromptInputEditor } from "./app-input-pane.js";
import { palette } from "./app-model.js";
import { appendVoiceText, insertableVoiceText } from "./app-voice-text.js";
import type {
  TuiOptions,
  TuiVoiceErrorCode,
  TuiVoiceInputError,
  TuiVoiceSession,
} from "./types.js";

export type VoiceInputPhase = "idle" | "recording" | "transcribing";

export type VoiceInputStatusView = {
  phase: Exclude<VoiceInputPhase, "idle">;
  elapsedSeconds: number;
};

const VOICE_ERROR_CODES: readonly TuiVoiceErrorCode[] = [
  "not_configured",
  "start_failed",
  "transcribe_failed",
  "unsupported",
];

const VOICE_TIMER_INTERVAL_MS = 1_000;

type UseVoiceInputOptions = {
  busy: boolean;
  copy: TuiCopy;
  getDraftValue: () => string;
  inputEditorRef: MutableRefObject<PromptInputEditor | null>;
  options: TuiOptions;
  setDraftValue: (value: string) => void;
  setStatus: Dispatch<SetStateAction<string>>;
  setStatusDetails: Dispatch<SetStateAction<string[]>>;
};

type UseVoiceInputResult = {
  handleVoiceKey: () => void;
  voiceStatus: VoiceInputStatusView | undefined;
};

export function useVoiceInput({
  busy,
  copy,
  getDraftValue,
  inputEditorRef,
  options,
  setDraftValue,
  setStatus,
  setStatusDetails,
}: UseVoiceInputOptions): UseVoiceInputResult {
  const [phase, setPhase] = useState<VoiceInputPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const sessionRef = useRef<TuiVoiceSession | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Transcription itself is awaited inside closures; the timer only drives the
  // recording duration label, so it can tick independently of phase plumbing.
  const phaseRef = useRef<VoiceInputPhase>("idle");
  phaseRef.current = phase;

  const clearVoiceTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const resetVoiceState = useCallback(() => {
    clearVoiceTimer();
    setElapsedSeconds(0);
    setPhase("idle");
  }, [clearVoiceTimer]);

  const reportVoiceError = useCallback(
    (error: unknown) => {
      const { status, details } = voiceErrorStatus(error, copy);
      setStatus(status);
      setStatusDetails(details);
    },
    [copy, setStatus, setStatusDetails],
  );

  const beginRecording = useCallback(async () => {
    if (!options.voiceInput) {
      setStatus(copy.voice.unavailable);
      return;
    }
    setPhase("recording");
    setElapsedSeconds(0);
    timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), VOICE_TIMER_INTERVAL_MS);
    try {
      sessionRef.current = await options.voiceInput.beginSession();
    } catch (error) {
      resetVoiceState();
      reportVoiceError(error);
    }
  }, [copy, options, reportVoiceError, resetVoiceState, setStatus]);

  const stopAndTranscribe = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = undefined;
    clearVoiceTimer();
    if (!session) {
      resetVoiceState();
      return;
    }
    setPhase("transcribing");
    try {
      const text = await session.stop();
      const trimmed = text.trim();
      if (!trimmed) {
        setStatus(copy.voice.emptyResult);
      } else {
        insertVoiceTranscript({
          editor: inputEditorRef.current,
          getDraftValue,
          setDraftValue,
          text: trimmed,
        });
        setStatus(copy.voice.insertedText(trimmed.length));
      }
    } catch (error) {
      reportVoiceError(error);
    } finally {
      resetVoiceState();
    }
  }, [
    clearVoiceTimer,
    copy,
    getDraftValue,
    inputEditorRef,
    reportVoiceError,
    resetVoiceState,
    setDraftValue,
    setStatus,
  ]);

  const handleVoiceKey = useCallback(() => {
    const current = phaseRef.current;
    if (current === "recording") {
      void stopAndTranscribe();
      return;
    }
    if (current === "transcribing") return;
    if (busy) {
      setStatus(copy.voice.busyStatus);
      return;
    }
    void beginRecording();
  }, [beginRecording, busy, copy, setStatus, stopAndTranscribe]);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearInterval(timerRef.current);
      void sessionRef.current?.cancel().catch(() => undefined);
      sessionRef.current = undefined;
    },
    [],
  );

  return {
    handleVoiceKey,
    voiceStatus: phase === "idle" ? undefined : { phase, elapsedSeconds },
  };
}

function voiceErrorStatus(error: unknown, copy: TuiCopy): { status: string; details: string[] } {
  const voiceError = asVoiceInputError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (!voiceError) return { status: copy.voice.transcribeFailed(message), details: [message] };
  switch (voiceError.code) {
    case "not_configured":
      return {
        status: voiceNotConfiguredStatus(voiceError, copy),
        details: [message],
      };
    case "start_failed":
      return { status: copy.voice.startFailed(message), details: [message] };
    case "unsupported":
      return { status: copy.voice.unavailable, details: [message] };
    default:
      return { status: copy.voice.transcribeFailed(message), details: [message] };
  }
}

function voiceNotConfiguredStatus(error: TuiVoiceInputError, copy: TuiCopy): string {
  // Host marks the missing key in the message prefix ("whisperModelPath"/"glmApiKey").
  const provider = error.message.startsWith("glmApiKey") ? "glm" : "whisper";
  return provider === "glm" ? copy.voice.notConfiguredGlm : copy.voice.notConfiguredWhisper;
}

function asVoiceInputError(error: unknown): TuiVoiceInputError | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as TuiVoiceInputError).code;
  return VOICE_ERROR_CODES.includes(code) ? (error as TuiVoiceInputError) : undefined;
}

export function insertVoiceTranscript(options: {
  editor: PromptInputEditor | null;
  getDraftValue: () => string;
  setDraftValue: (value: string) => void;
  text: string;
}): void {
  const { editor, getDraftValue, setDraftValue, text } = options;
  if (!editor) {
    setDraftValue(appendVoiceText(getDraftValue(), text));
    return;
  }
  try {
    const payload = insertableVoiceText(editor.plainText, editor.cursorOffset, text);
    editor.insertText(payload);
    editor.focus();
    setDraftValue(editor.plainText);
  } catch {
    setDraftValue(appendVoiceText(getDraftValue(), text));
  }
}

export function VoiceStatusRow({
  copy,
  status,
}: {
  copy: TuiCopy;
  status: VoiceInputStatusView;
}): React.ReactElement {
  const h = React.createElement as (
    type: React.ElementType | string,
    props?: Record<string, unknown> | null,
    ...children: React.ReactNode[]
  ) => React.ReactElement;
  const label =
    status.phase === "recording"
      ? copy.voice.recording(status.elapsedSeconds)
      : copy.voice.transcribing;
  return h(
    "box",
    {
      style: {
        flexDirection: "row",
        height: 1,
        paddingLeft: 1,
        width: "100%",
      },
    },
    h(
      "text",
      { style: { fg: status.phase === "recording" ? palette.warning : palette.accent } },
      label,
    ),
  );
}
