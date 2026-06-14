import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { LlmRuntimeLimitsSnapshot } from "../types/appTypes";
import { parseLlmRuntimeLimitsSnapshot } from "../utils/llmSession";

type UseLlmRuntimeLimitsControllerArgs = {
  auxServerBaseUrl: () => string;
  runnerToken: string;
  llmToolMaxRoundsInput: string;
  setLlmRuntimeLimits: Dispatch<SetStateAction<LlmRuntimeLimitsSnapshot | null>>;
  setLlmRuntimeLimitsError: Dispatch<SetStateAction<string>>;
  setLlmRuntimeLimitsLoading: Dispatch<SetStateAction<boolean>>;
  setLlmToolMaxRoundsInput: Dispatch<SetStateAction<string>>;
  setLlmToolMaxRoundsSaving: Dispatch<SetStateAction<boolean>>;
  setReplyDebug: Dispatch<SetStateAction<string>>;
};

export function useLlmRuntimeLimitsController({
  auxServerBaseUrl,
  runnerToken,
  llmToolMaxRoundsInput,
  setLlmRuntimeLimits,
  setLlmRuntimeLimitsError,
  setLlmRuntimeLimitsLoading,
  setLlmToolMaxRoundsInput,
  setLlmToolMaxRoundsSaving,
  setReplyDebug,
}: UseLlmRuntimeLimitsControllerArgs) {
  const loadLlmRuntimeLimits = useCallback(async () => {
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) {
      setLlmRuntimeLimitsError("Aux Server URL または Runner Token が未設定です");
      return;
    }
    setLlmRuntimeLimitsLoading(true);
    setLlmRuntimeLimitsError("");
    try {
      const url = new URL(`${targetLlmUrl}/config/limits`);
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(data?.message || data?.error || `HTTP ${res.status}`));
      }
      const snapshot = parseLlmRuntimeLimitsSnapshot(data);
      setLlmRuntimeLimits(snapshot);
      if (snapshot.toolMaxRounds !== null) {
        setLlmToolMaxRoundsInput(String(snapshot.toolMaxRounds));
      }
      const llmTimeoutText = snapshot.llmTimeoutMs !== null ? `${snapshot.llmTimeoutMs}ms` : "-";
      const roundsText = snapshot.toolMaxRounds !== null ? String(snapshot.toolMaxRounds) : "-";
      setReplyDebug(`limits llmTimeout=${llmTimeoutText} toolMaxRounds=${roundsText}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLlmRuntimeLimitsError(message);
    } finally {
      setLlmRuntimeLimitsLoading(false);
    }
  }, [
    auxServerBaseUrl,
    runnerToken,
    setLlmRuntimeLimits,
    setLlmRuntimeLimitsError,
    setLlmRuntimeLimitsLoading,
    setLlmToolMaxRoundsInput,
    setReplyDebug,
  ]);

  const updateLlmToolMaxRounds = useCallback(async () => {
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) {
      setLlmRuntimeLimitsError("Aux Server URL または Runner Token が未設定です");
      return;
    }
    const nextRounds = Number(llmToolMaxRoundsInput);
    if (!Number.isInteger(nextRounds) || nextRounds < 1 || nextRounds > 1000) {
      setLlmRuntimeLimitsError("toolMaxRounds は 1-1000 の整数で指定してください");
      return;
    }
    setLlmToolMaxRoundsSaving(true);
    setLlmRuntimeLimitsError("");
    try {
      const url = new URL(`${targetLlmUrl}/config/limits`);
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          llm: {
            toolMaxRounds: nextRounds,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(data?.message || data?.error || `HTTP ${res.status}`));
      }
      setReplyDebug(`limits toolMaxRounds=${nextRounds} updated`);
      await loadLlmRuntimeLimits();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLlmRuntimeLimitsError(message);
    } finally {
      setLlmToolMaxRoundsSaving(false);
    }
  }, [
    auxServerBaseUrl,
    llmToolMaxRoundsInput,
    loadLlmRuntimeLimits,
    runnerToken,
    setLlmRuntimeLimitsError,
    setLlmToolMaxRoundsSaving,
    setReplyDebug,
  ]);

  const fetchRunnerLlmRuntimeLimitsForStatus = useCallback(async (): Promise<LlmRuntimeLimitsSnapshot | null> => {
    const targetLlmUrl = auxServerBaseUrl();
    const token = runnerToken.trim();
    if (!targetLlmUrl || !token) return null;
    try {
      const url = new URL(`${targetLlmUrl}/config/limits`);
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      const snapshot = parseLlmRuntimeLimitsSnapshot(data);
      setLlmRuntimeLimits(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }, [auxServerBaseUrl, runnerToken, setLlmRuntimeLimits]);

  return {
    loadLlmRuntimeLimits,
    updateLlmToolMaxRounds,
    fetchRunnerLlmRuntimeLimitsForStatus,
  };
}
