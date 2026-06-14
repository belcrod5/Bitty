import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { LlmDeltaEntry, LlmDeltaSource, StreamSegment, StreamSegmentStatus } from "../types/appTypes";

type UseLlmTraceStateControllerArgs = {
  setStreamSegments: Dispatch<SetStateAction<StreamSegment[]>>;
  setStreamLlmDeltas: Dispatch<SetStateAction<LlmDeltaEntry[]>>;
  stripYouTubeTags: (text: string) => string;
};

export function useLlmTraceStateController({
  setStreamSegments,
  setStreamLlmDeltas,
  stripYouTubeTags,
}: UseLlmTraceStateControllerArgs) {
  const upsertStreamSegment = useCallback((
    seq: number,
    text: string,
    status: StreamSegmentStatus,
    extra: Partial<StreamSegment> = {}
  ) => {
    setStreamSegments((prev) => {
      const next = [...prev];
      const index = next.findIndex((item) => item.seq === seq);
      if (index >= 0) {
        next[index] = {
          ...next[index],
          text: text || next[index].text,
          status,
          ...extra,
        };
      } else {
        next.push({
          seq,
          text,
          status,
          playedSinceFirstNativeDeltaMs: null,
          llmNativeDeltaCountAtPlayed: null,
          llmNativeDeltaLastAtPlayed: null,
          ...extra,
        });
      }
      next.sort((a, b) => a.seq - b.seq);
      return next;
    });
  }, [setStreamSegments]);

  const appendLlmDelta = useCallback((source: LlmDeltaSource, text: string) => {
    if (!text) return;
    setStreamLlmDeltas((prev) => [...prev, { source, text }].slice(-12));
  }, [setStreamLlmDeltas]);

  const applyAssistantReply = useCallback((rawReply: string) => {
    return stripYouTubeTags(rawReply);
  }, [stripYouTubeTags]);

  return {
    upsertStreamSegment,
    appendLlmDelta,
    applyAssistantReply,
  };
}
