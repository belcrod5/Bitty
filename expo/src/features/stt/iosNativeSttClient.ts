type IosNativeSttRequest = {
  uri: string;
  language: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

type IosNativeDirectSttRequest = {
  language: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onInterimTranscript?: (text: string) => void;
  onFinalTranscript?: (text: string) => void;
  onStateChange?: (state: "starting" | "listening" | "stopped") => void;
};

export type IosNativeDirectSttSession = {
  stop: () => void;
  abort: () => void;
  done: Promise<string>;
};

type EventSubscription = { remove: () => void };
type SpeechRecognitionErrorCode = "aborted" | "no-speech" | string;
type SpeechRecognitionResultEvent = {
  isFinal: boolean;
  results?: Array<{ transcript?: string }>;
};
type SpeechRecognitionErrorEvent = {
  error?: SpeechRecognitionErrorCode;
  message?: string;
};

function toCanonicalLocale(raw: string) {
  const text = String(raw || "").trim().replace(/_/g, "-");
  if (!text) return "";
  const parts = text.split("-").filter(Boolean);
  if (!parts.length) return "";
  const lang = parts[0].toLowerCase();
  if (parts.length === 1) return lang;
  const rest = parts.slice(1).map((part) => {
    if (part.length === 2) return part.toUpperCase();
    if (part.length === 4) return `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`;
    return part;
  });
  return [lang, ...rest].join("-");
}

function resolveIosLocale(rawLanguage: string, supportedLocales: string[]) {
  const requested = toCanonicalLocale(rawLanguage);
  if (!requested) return "ja-JP";
  if (!supportedLocales.length) {
    if (requested === "ja") return "ja-JP";
    return requested;
  }

  const supported = supportedLocales.map((value) => toCanonicalLocale(value)).filter(Boolean);
  const supportedSet = new Set(supported);
  if (supportedSet.has(requested)) return requested;

  const languageCode = requested.split("-")[0];
  if (requested === "ja" && supportedSet.has("ja-JP")) return "ja-JP";
  const matched = supported.find((locale) => locale.startsWith(`${languageCode}-`));
  if (matched) return matched;

  return supportedSet.has("ja-JP") ? "ja-JP" : requested;
}

function createAbortError(message = "aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function resolveTopTranscript(event: SpeechRecognitionResultEvent | null | undefined) {
  return String(event?.results?.[0]?.transcript || "").trim();
}

async function resolveIosSpeechRecognitionSetup(rawLanguage: string) {
  let speechRecognitionPackage: any = null;
  try {
    speechRecognitionPackage = await import("expo-speech-recognition");
  } catch {
    throw new Error(
      "iOS native STT is unavailable in this runtime. Build a Development Build with expo-speech-recognition."
    );
  }

  const ExpoSpeechRecognitionModule = speechRecognitionPackage?.ExpoSpeechRecognitionModule;
  if (!ExpoSpeechRecognitionModule || typeof ExpoSpeechRecognitionModule.start !== "function") {
    throw new Error(
      "iOS native STT module is unavailable. Rebuild iOS app after prebuild with expo-speech-recognition plugin."
    );
  }

  const isRecognitionAvailable = ExpoSpeechRecognitionModule.isRecognitionAvailable?.();
  if (isRecognitionAvailable === false) {
    throw new Error("iOS speech recognition is not available on this device.");
  }

  const supportedLocales = await ExpoSpeechRecognitionModule.getSupportedLocales?.({})
    .then((result: any) => (Array.isArray(result?.locales) ? result.locales : []))
    .catch(() => []);
  const resolvedLocale = resolveIosLocale(rawLanguage, supportedLocales);

  const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!permission?.granted) {
    throw new Error("iOS speech recognition permission is denied.");
  }

  return {
    speechRecognitionPackage,
    ExpoSpeechRecognitionModule,
    resolvedLocale,
  };
}

export async function requestIosNativeSttTranscript(options: IosNativeSttRequest) {
  const uri = String(options.uri || "").trim();
  if (!uri) return "";

  const { speechRecognitionPackage, ExpoSpeechRecognitionModule, resolvedLocale } =
    await resolveIosSpeechRecognitionSetup(options.language);

  return await new Promise<string>((resolve, reject) => {
    const subscriptions: EventSubscription[] = [];
    let latestTranscript = "";
    let finalTranscript = "";
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timeoutFired = false;

    const handleAbortSignal = () => {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {}
      fail(createAbortError("stt request cancelled"));
    };

    const cleanup = () => {
      for (const sub of subscriptions) {
        try {
          sub.remove();
        } catch {}
      }
      subscriptions.length = 0;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      options.signal?.removeEventListener("abort", handleAbortSignal);
    };

    const complete = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    if (options.signal?.aborted) {
      fail(createAbortError("stt request cancelled"));
      return;
    }
    options.signal?.addEventListener("abort", handleAbortSignal);

    if (options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timeoutFired = true;
        try {
          ExpoSpeechRecognitionModule.abort();
        } catch {}
        fail(new Error(`stt request timeout (${options.timeoutMs}ms)`));
      }, options.timeoutMs);
    }

    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("result", (event: SpeechRecognitionResultEvent) => {
        const text = resolveTopTranscript(event);
        if (!text) return;
        latestTranscript = text;
        if (event?.isFinal) {
          finalTranscript = text;
        }
      })
    );

    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("error", (event: SpeechRecognitionErrorEvent) => {
        if (event?.error === "aborted" && (options.signal?.aborted || timeoutFired)) {
          fail(createAbortError("stt request cancelled"));
          return;
        }
        if (event?.error === "no-speech") {
          complete("");
          return;
        }
        fail(new Error(String(event?.message || event?.error || "iOS speech recognition error")));
      })
    );

    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("nomatch", () => {
        complete("");
      })
    );

    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("end", () => {
        complete(finalTranscript || latestTranscript || "");
      })
    );

    try {
      const AVAudioSessionCategory = speechRecognitionPackage?.AVAudioSessionCategory;
      const AVAudioSessionCategoryOptions = speechRecognitionPackage?.AVAudioSessionCategoryOptions;
      const AVAudioSessionMode = speechRecognitionPackage?.AVAudioSessionMode;
      ExpoSpeechRecognitionModule.start({
        lang: resolvedLocale,
        interimResults: false,
        continuous: false,
        addsPunctuation: true,
        requiresOnDeviceRecognition: true,
        iosTaskHint: "dictation",
        iosCategory: {
          category: AVAudioSessionCategory?.playAndRecord || "playAndRecord",
          categoryOptions: [
            AVAudioSessionCategoryOptions?.defaultToSpeaker || "defaultToSpeaker",
            AVAudioSessionCategoryOptions?.allowBluetooth || "allowBluetooth",
          ],
          mode: AVAudioSessionMode?.measurement || "measurement",
        },
        audioSource: { uri },
      });
    } catch (error) {
      fail(error);
    }
  });
}

export async function startIosNativeDirectSttSession(
  options: IosNativeDirectSttRequest
): Promise<IosNativeDirectSttSession> {
  const { speechRecognitionPackage, ExpoSpeechRecognitionModule, resolvedLocale } =
    await resolveIosSpeechRecognitionSetup(options.language);

  let stopImpl = () => {};
  let abortImpl = () => {};

  const done = new Promise<string>((resolve, reject) => {
    const subscriptions: EventSubscription[] = [];
    let latestTranscript = "";
    let finalTranscript = "";
    let settled = false;
    let stopRequested = false;
    let abortRequested = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timeoutFired = false;

    const requestStop = () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      try {
        if (typeof ExpoSpeechRecognitionModule.stop === "function") {
          ExpoSpeechRecognitionModule.stop();
          return;
        }
      } catch {}
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {}
    };

    const requestAbort = () => {
      if (settled || abortRequested) return;
      abortRequested = true;
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {}
    };

    stopImpl = requestStop;
    abortImpl = requestAbort;

    const handleAbortSignal = () => {
      requestAbort();
      fail(createAbortError("stt request cancelled"));
    };

    const cleanup = () => {
      for (const sub of subscriptions) {
        try {
          sub.remove();
        } catch {}
      }
      subscriptions.length = 0;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      options.signal?.removeEventListener("abort", handleAbortSignal);
      options.onStateChange?.("stopped");
    };

    const complete = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    if (options.signal?.aborted) {
      fail(createAbortError("stt request cancelled"));
      return;
    }
    options.signal?.addEventListener("abort", handleAbortSignal);

    const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timeoutFired = true;
        requestAbort();
        fail(new Error(`stt request timeout (${timeoutMs}ms)`));
      }, timeoutMs);
    }

    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("result", (event: SpeechRecognitionResultEvent) => {
        const text = resolveTopTranscript(event);
        if (!text) return;
        latestTranscript = text;
        if (event?.isFinal) {
          finalTranscript = text;
          options.onFinalTranscript?.(text);
          return;
        }
        options.onInterimTranscript?.(text);
      })
    );

    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("error", (event: SpeechRecognitionErrorEvent) => {
        if (event?.error === "aborted") {
          if (stopRequested) {
            complete(finalTranscript || latestTranscript || "");
            return;
          }
          if (abortRequested || options.signal?.aborted || timeoutFired) {
            fail(createAbortError("stt request cancelled"));
            return;
          }
        }
        if (event?.error === "no-speech") {
          complete(finalTranscript || latestTranscript || "");
          return;
        }
        fail(new Error(String(event?.message || event?.error || "iOS speech recognition error")));
      })
    );

    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("nomatch", () => {
        complete(finalTranscript || latestTranscript || "");
      })
    );

    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("end", () => {
        complete(finalTranscript || latestTranscript || "");
      })
    );

    try {
      options.onStateChange?.("starting");
      const AVAudioSessionCategory = speechRecognitionPackage?.AVAudioSessionCategory;
      const AVAudioSessionCategoryOptions = speechRecognitionPackage?.AVAudioSessionCategoryOptions;
      const AVAudioSessionMode = speechRecognitionPackage?.AVAudioSessionMode;
      ExpoSpeechRecognitionModule.start({
        lang: resolvedLocale,
        interimResults: true,
        continuous: false,
        addsPunctuation: true,
        requiresOnDeviceRecognition: true,
        iosTaskHint: "dictation",
        iosCategory: {
          category: AVAudioSessionCategory?.playAndRecord || "playAndRecord",
          categoryOptions: [
            AVAudioSessionCategoryOptions?.defaultToSpeaker || "defaultToSpeaker",
            AVAudioSessionCategoryOptions?.allowBluetooth || "allowBluetooth",
          ],
          mode: AVAudioSessionMode?.measurement || "measurement",
        },
      });
      options.onStateChange?.("listening");
    } catch (error) {
      fail(error);
    }
  });

  return {
    stop: () => {
      stopImpl();
    },
    abort: () => {
      abortImpl();
    },
    done,
  };
}
