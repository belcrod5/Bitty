export type StreamingSttTransportCallbacks = {
  continueDuringCorrection?: boolean;
  onMessage: (raw: unknown) => void;
  onSample: (rms: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onDiagnostic?: (payload: Record<string, unknown>) => void;
};

export type StreamingSttSession = {
  commit?: (revision: number) => Promise<boolean>;
  setInputMuted?: (muted: boolean) => Promise<void>;
  stop: () => Promise<void>;
  abort: () => Promise<void>;
};
