import { renderHook, waitFor } from "@testing-library/react-native";
import { transcribeWithConfiguredProvider } from "../../stt/sttService";
import { useRecordingTranscriptionController } from "./useRecordingTranscriptionController";

jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 128 })),
}));

jest.mock("../../stt/sttService", () => ({
  transcribeWithConfiguredProvider: jest.fn(),
}));

const mockTranscribeWithConfiguredProvider = transcribeWithConfiguredProvider as jest.Mock;

type ControllerOptions = Parameters<typeof useRecordingTranscriptionController>[0];

function ref<T>(current: T) {
  return { current };
}

function createOptions() {
  const sendReplyTranscript = jest.fn(async () => {});
  const logAuto = jest.fn();
  const options: ControllerOptions = {
    sttProvider: "runner",
    runnerUrl: "http://runner.test",
    runnerToken: "runner-token",
    recordingUri: "",
    nearUnlimitedTimeoutMs: 1_000,
    sttLoadingRef: ref(false),
    autoRecordingEnabledRef: ref(true),
    autoReplyAfterSttRef: ref(true),
    replyLoadingRef: ref(false),
    autoLastBargeInDetectedAtRef: ref(0),
    autoLastTtsStopRequestedAtRef: ref(0),
    autoLastTtsStoppedAtRef: ref(0),
    setSttLoading: jest.fn(),
    setTranscript: jest.fn(),
    setErrorMessage: jest.fn(),
    getBaseUrl: () => "http://runner.test",
    waitForReplyIdle: jest.fn(async () => {}),
    sendReplyTranscript,
    faceTrackingAllowsStt: () => true,
    elapsedSinceMs: () => null,
    logAuto,
    reportError: jest.fn(),
  };

  return { options, sendReplyTranscript, logAuto };
}

describe("useRecordingTranscriptionController panel target", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTranscribeWithConfiguredProvider.mockResolvedValue("transcribed voice");
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the captured panel to sendReplyTranscript", async () => {
    const harness = createOptions();
    const { result } = await renderHook(() => useRecordingTranscriptionController(harness.options));

    await result.current.transcribeRecording("file:///voice.m4a", "panel-a");

    expect(harness.sendReplyTranscript).toHaveBeenCalledWith(
      "transcribed voice",
      expect.objectContaining({ panelId: "panel-a" }),
    );
  });

  it("keeps the enqueued panel snapshot after the recording target is cleared", async () => {
    const harness = createOptions();
    const targetRef = ref("panel-original");
    const { result } = await renderHook(() => useRecordingTranscriptionController(harness.options));

    result.current.enqueueAutoTranscribe(
      "file:///queued-voice.m4a",
      "silence",
      targetRef.current,
    );
    targetRef.current = "";

    await waitFor(() => {
      expect(harness.sendReplyTranscript).toHaveBeenCalledWith(
        "transcribed voice",
        expect.objectContaining({ panelId: "panel-original" }),
      );
    });
    expect(harness.logAuto).toHaveBeenCalledWith("auto_transcribe_enqueued", {
      sourceReason: "silence",
      panelId: "panel-original",
    });
  });
});
