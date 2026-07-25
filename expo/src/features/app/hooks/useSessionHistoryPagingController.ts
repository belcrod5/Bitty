import { useCallback, useRef, useState } from "react";
import type { RunnerSessionMessagesResult } from "./useLlmSessionExplorer";

export type SessionHistoryPagingState = {
  olderCursor: string | null;
  loading: boolean;
  error: string;
  errorCode: string;
};

type InternalPageState = SessionHistoryPagingState & {
  generation: number;
};

export function useSessionHistoryPagingController(options: {
  fetchPage: (
    sessionId: string,
    directory: string,
    options: { cursor: string }
  ) => Promise<RunnerSessionMessagesResult>;
  applyPage: (sessionId: string, page: RunnerSessionMessagesResult) => void;
}) {
  const { fetchPage, applyPage } = options;
  const pageStateRef = useRef<Record<string, InternalPageState>>({});
  const [stateBySessionId, setStateBySessionId] = useState<Record<string, SessionHistoryPagingState>>({});

  const publish = useCallback((sessionId: string, next: InternalPageState) => {
    pageStateRef.current = { ...pageStateRef.current, [sessionId]: next };
    setStateBySessionId((current) => ({
      ...current,
      [sessionId]: {
        olderCursor: next.olderCursor,
        loading: next.loading,
        error: next.error,
        errorCode: next.errorCode,
      },
    }));
  }, []);

  const registerPage = useCallback((sessionIdRaw: string, page: RunnerSessionMessagesResult) => {
    const sessionId = String(sessionIdRaw || "").trim();
    if (!sessionId) return;
    const previous = pageStateRef.current[sessionId];
    publish(sessionId, {
      olderCursor: page.olderCursor,
      loading: false,
      error: "",
      errorCode: "",
      generation: (previous?.generation || 0) + 1,
    });
  }, [publish]);

  const loadOlder = useCallback(async (params: { sessionId: string; directory: string; retry?: boolean }) => {
    const sessionId = String(params.sessionId || "").trim();
    const directory = String(params.directory || "").trim();
    const current = pageStateRef.current[sessionId];
    if (!sessionId || !current?.olderCursor || current.loading || (current.error && !params.retry)) return;
    const cursor = current.olderCursor;
    const generation = current.generation;
    publish(sessionId, { ...current, loading: true, error: "", errorCode: "" });
    try {
      const page = await fetchPage(sessionId, directory, { cursor });
      const latest = pageStateRef.current[sessionId];
      if (!latest || latest.generation !== generation || latest.olderCursor !== cursor) return;
      applyPage(sessionId, page);
      publish(sessionId, {
        olderCursor: page.olderCursor,
        loading: false,
        error: "",
        errorCode: "",
        generation,
      });
    } catch (error) {
      const latest = pageStateRef.current[sessionId];
      if (!latest || latest.generation !== generation || latest.olderCursor !== cursor) return;
      publish(sessionId, {
        ...latest,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code || "")
          : "",
      });
    }
  }, [applyPage, fetchPage, publish]);

  return { stateBySessionId, registerPage, loadOlder };
}
