export type StreamingSttTransportCallbacks = {
  onMessage: (raw: unknown) => void;
  onSample: (rms: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
};

export type StreamingSttSession = {
  stop: () => Promise<void>;
  abort: () => Promise<void>;
};
