import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { SelectedVoiceIdByProvider, TtsProvider } from "../utils/audioConfig";

export type VoiceOption = {
  voiceId: string;
  name: string;
  category: string;
  previewUrl: string;
};

type UseTtsVoiceCatalogOptions = {
  runnerUrl: string;
  runnerToken: string;
  ttsProvider: TtsProvider;
  getBaseUrl: () => string;
  selectedVoiceIdByProvider: SelectedVoiceIdByProvider;
  setSelectedVoiceIdByProvider: Dispatch<SetStateAction<SelectedVoiceIdByProvider>>;
  setErrorMessage: (message: string) => void;
  reportError: (raw: unknown, scope?: string) => void;
};

function normalizeVoiceOptions(raw: unknown): VoiceOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((itemRaw: unknown) => {
      const item = itemRaw && typeof itemRaw === "object" ? itemRaw as Record<string, unknown> : {};
      return {
        voiceId: String(item.voiceId || ""),
        name: String(item.name || ""),
        category: String(item.category || ""),
        previewUrl: String(item.previewUrl || ""),
      };
    })
    .filter((item: VoiceOption) => !!item.voiceId);
}

export function useTtsVoiceCatalog(options: UseTtsVoiceCatalogOptions) {
  const {
    runnerUrl,
    runnerToken,
    ttsProvider,
    getBaseUrl,
    selectedVoiceIdByProvider,
    setSelectedVoiceIdByProvider,
    setErrorMessage,
    reportError,
  } = options;

  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceFilter, setVoiceFilter] = useState("");

  const filteredVoices = useMemo(() => {
    const q = voiceFilter.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter((voice) => (
      voice.name.toLowerCase().includes(q) ||
      voice.voiceId.toLowerCase().includes(q) ||
      voice.category.toLowerCase().includes(q)
    ));
  }, [voiceFilter, voices]);

  const selectedVoiceId = useMemo(
    () => String(selectedVoiceIdByProvider[ttsProvider] || "").trim(),
    [selectedVoiceIdByProvider, ttsProvider]
  );

  useEffect(() => {
    setVoices([]);
    setVoiceFilter("");
  }, [ttsProvider]);

  const loadVoices = useCallback(async () => {
    if (!runnerUrl.trim() || !runnerToken.trim() || voicesLoading) return;
    setVoicesLoading(true);
    setErrorMessage("");
    try {
      const res = await fetch(
        `${getBaseUrl()}/voices?ttsProvider=${encodeURIComponent(ttsProvider)}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${runnerToken.trim()}`,
          },
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      const nextVoices = normalizeVoiceOptions(data?.voices);
      setVoices(nextVoices);
      const serverDefault = String(data?.defaultVoiceId || "").trim();
      setSelectedVoiceIdByProvider((prev) => {
        const current = String(prev[ttsProvider] || "").trim();
        let resolved = "";
        if (current && nextVoices.some((voice) => voice.voiceId === current)) {
          resolved = current;
        } else if (serverDefault && nextVoices.some((voice) => voice.voiceId === serverDefault)) {
          resolved = serverDefault;
        } else {
          resolved = nextVoices[0]?.voiceId || "";
        }
        return {
          ...prev,
          [ttsProvider]: resolved,
        };
      });
    } catch (error) {
      reportError(error, "voices");
    } finally {
      setVoicesLoading(false);
    }
  }, [
    getBaseUrl,
    reportError,
    runnerToken,
    runnerUrl,
    setErrorMessage,
    setSelectedVoiceIdByProvider,
    ttsProvider,
    voicesLoading,
  ]);

  return {
    voices,
    voicesLoading,
    voiceFilter,
    filteredVoices,
    selectedVoiceId,
    setVoiceFilter,
    loadVoices,
  };
}
