import { useCallback, useEffect, useRef, useState } from "react";

export type LlmUiStatus =
  | "idle"
  | "connecting"
  | "model_processing"
  | "tool_waiting_approval"
  | "tool_running"
  | "model_generating"
  | "completed"
  | "error";

type UseLlmRequestStatusOptions = {
  replyLoading: boolean;
  liveLlmStatusDetail: (status: LlmUiStatus, baseDetail: string, elapsedMs: number) => string;
  onStartRequest: () => void;
  onFinishRequest: () => void;
  setChatThinkingLogExpanded: (expanded: boolean) => void;
};

export function useLlmRequestStatus(options: UseLlmRequestStatusOptions) {
  const {
    replyLoading,
    liveLlmStatusDetail,
    onStartRequest,
    onFinishRequest,
    setChatThinkingLogExpanded,
  } = options;

  const [llmUiStatus, setLlmUiStatus] = useState<LlmUiStatus>("idle");
  const [llmUiStatusDetail, setLlmUiStatusDetail] = useState("");
  const [llmElapsedMs, setLlmElapsedMs] = useState(0);
  const [llmElapsedLiveMs, setLlmElapsedLiveMs] = useState(0);
  const llmUiStatusRef = useRef<LlmUiStatus>("idle");
  const llmUiStatusDetailBaseRef = useRef("");
  const llmRequestStartedAtRef = useRef(0);
  const liveLlmStatusDetailRef = useRef(liveLlmStatusDetail);

  useEffect(() => {
    liveLlmStatusDetailRef.current = liveLlmStatusDetail;
  }, [liveLlmStatusDetail]);

  const updateLlmStatus = useCallback((next: LlmUiStatus, detail = "") => {
    llmUiStatusRef.current = next;
    llmUiStatusDetailBaseRef.current = detail;
    setLlmUiStatus(next);
    if (
      replyLoading &&
      llmRequestStartedAtRef.current > 0 &&
      next !== "completed" &&
      next !== "error" &&
      next !== "idle"
    ) {
      const elapsedMs = Date.now() - llmRequestStartedAtRef.current;
      setLlmUiStatusDetail(liveLlmStatusDetailRef.current(next, detail, elapsedMs));
      return;
    }
    setLlmUiStatusDetail(detail);
  }, [replyLoading]);

  const startLlmRequest = useCallback((initialStatus: LlmUiStatus, detail = "") => {
    llmRequestStartedAtRef.current = Date.now();
    onStartRequest();
    setLlmElapsedMs(0);
    setLlmElapsedLiveMs(0);
    setChatThinkingLogExpanded(false);
    updateLlmStatus(initialStatus, detail);
  }, [onStartRequest, setChatThinkingLogExpanded, updateLlmStatus]);

  const finishLlmRequest = useCallback((finalStatus: LlmUiStatus, detail = "") => {
    updateLlmStatus(finalStatus, detail);
    if (llmRequestStartedAtRef.current > 0) {
      const elapsedMs = Date.now() - llmRequestStartedAtRef.current;
      setLlmElapsedMs(elapsedMs);
      setLlmElapsedLiveMs(elapsedMs);
    }
    onFinishRequest();
  }, [onFinishRequest, updateLlmStatus]);

  useEffect(() => {
    if (!replyLoading || llmRequestStartedAtRef.current <= 0) return;
    const updateLiveStatus = () => {
      const elapsedMs = Date.now() - llmRequestStartedAtRef.current;
      setLlmElapsedLiveMs(elapsedMs);
      const status = llmUiStatusRef.current;
      if (status === "completed" || status === "error" || status === "idle") return;
      const base = llmUiStatusDetailBaseRef.current;
      setLlmUiStatusDetail(liveLlmStatusDetailRef.current(status, base, elapsedMs));
    };
    updateLiveStatus();
    const timer = setInterval(() => {
      updateLiveStatus();
    }, 1000);
    return () => clearInterval(timer);
  }, [replyLoading]);

  return {
    llmUiStatus,
    llmUiStatusDetail,
    llmElapsedMs,
    llmElapsedLiveMs,
    llmUiStatusRef,
    llmUiStatusDetailBaseRef,
    llmRequestStartedAtRef,
    updateLlmStatus,
    startLlmRequest,
    finishLlmRequest,
  };
}
