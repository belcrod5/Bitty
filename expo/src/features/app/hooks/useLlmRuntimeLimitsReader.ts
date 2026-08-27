import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { LlmRuntimeLimitsSnapshot } from "../types/appTypes";
import { parseLlmRuntimeLimitsSnapshot } from "../utils/llmSession";

type UseLlmRuntimeLimitsReaderArgs = {
  auxServerBaseUrl: () => string;
  runnerToken: string;
  setLlmRuntimeLimits: Dispatch<SetStateAction<LlmRuntimeLimitsSnapshot | null>>;
};

export function useLlmRuntimeLimitsReader({
  auxServerBaseUrl,
  runnerToken,
  setLlmRuntimeLimits,
}: UseLlmRuntimeLimitsReaderArgs) {
  const fetchRunnerLlmRuntimeLimitsForStatus = useCallback(async (): Promise<LlmRuntimeLimitsSnapshot | null> => {
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) return null;
    try {
      const url = new URL(`${targetLlmUrl}/config/limits`);
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return null;
      const snapshot = parseLlmRuntimeLimitsSnapshot(data);
      setLlmRuntimeLimits(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }, [auxServerBaseUrl, runnerToken, setLlmRuntimeLimits]);

  return { fetchRunnerLlmRuntimeLimitsForStatus };
}
