export type StreamingSttTransportCallbacks = {
  continueDuringCorrection?: boolean;
  onMessage: (raw: unknown) => void;
  onSample: (rms: number) => void;
  onError: (message: string, retryable?: boolean) => void;
  onClose: () => void;
  onDiagnostic?: (payload: Record<string, unknown>) => void;
};

export type StreamingSttSession = {
  // False means the candidate is stale and capture continues; failures reject.
  commit?: (revision: number) => Promise<boolean>;
  setInputMuted?: (muted: boolean) => Promise<void>;
  playReadyCue?: (signal?: AbortSignal) => Promise<void>;
  stop: () => Promise<void>;
  abort: () => Promise<void>;
};
