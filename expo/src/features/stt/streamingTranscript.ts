export type StreamingTranscript = {
  baseText: string;
  finalText: string;
  interimText: string;
};

export function startStreamingTranscript(baseText: string): StreamingTranscript {
  return {
    baseText: String(baseText || "").trimEnd(),
    finalText: "",
    interimText: "",
  };
}

export function applyStreamingTranscript(
  state: StreamingTranscript,
  text: string,
  isFinal: boolean
): StreamingTranscript {
  const next = String(text || "");
  if (!isFinal) return { ...state, interimText: next };
  if (!next) return { ...state, interimText: "" };
  return {
    ...state,
    finalText: state.finalText + next,
    interimText: "",
  };
}

function joinBaseAndSpeech(baseText: string, speechText: string) {
  if (!baseText) return speechText;
  if (!speechText) return baseText;
  return `${baseText} ${speechText}`;
}

export function displayStreamingTranscript(state: StreamingTranscript) {
  return joinBaseAndSpeech(state.baseText, state.finalText + state.interimText);
}

export function finalStreamingTranscript(state: StreamingTranscript) {
  return joinBaseAndSpeech(state.baseText, state.finalText);
}
