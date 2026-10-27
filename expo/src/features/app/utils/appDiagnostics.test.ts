import { logAutoEvent, logSessionDiagEvent, ttsDiagnosticError } from "./appDiagnostics";

test("persists TTS traces while general auto diagnostics are disabled", () => {
  const enqueueLog = jest.fn();
  logAutoEvent({
    event: "tts_trace",
    payload: { stage: "native_error", runId: 3 },
    autoDiagnosticsEnabled: false,
    autoDiagnosticCriticalEvents: new Set(["tts_trace"]),
    enqueueLog,
  });
  expect(enqueueLog).toHaveBeenCalledWith("tts_trace", { stage: "native_error", runId: 3 });
});

test("diagnostic errors retain known codes without exposing free text, URLs, or tokens", () => {
  expect(ttsDiagnosticError(new Error("Failed at https://secret.example/audio?token=abc with private text")))
    .toBe("Error");
  expect(ttsDiagnosticError({ code: "audio_history_missing", message: "Bearer secret" }))
    .toBe("audio_history_missing");
  expect(ttsDiagnosticError("tts_key_missing")).toBe("tts_key_missing");
  expect(ttsDiagnosticError({ code: "tts_private_secret", message: "Bearer secret" }))
    .toBe("unknown_error");
  expect(ttsDiagnosticError(new Error("HTTP 503"))).toBe("HTTP_503");
  expect(ttsDiagnosticError(new Error("Failed at https://secret.example/?code=tts_secret")))
    .toBe("Error");
  expect(ttsDiagnosticError(new Error("private text contains job_secret and tts_secret")))
    .toBe("Error");
  expect(ttsDiagnosticError(new Error("provider says job_secret"))).toBe("Error");
  expect(ttsDiagnosticError("data:audio/mpeg;base64," + "A".repeat(200))).toBe("unknown_error");
});


test.each([false, true])("duplicate lifecycle details use the existing detail switch (%s)", (detailsEnabled) => {
  const enqueueLog = jest.fn();
  for (const event of ["mini_board_hydrate_request_received", "mini_board_hydrate_loaded_messages", "git_changed_files_refresh_settled"]) {
    logSessionDiagEvent({ event, payload: { count: 1 }, options: { throttleMs: 0, detailed: true },
      sessionDiagDetailEventsEnabled: detailsEnabled, sessionDiagEventThrottleDefaultMs: 1200,
      sessionDiagEventLastAtByKey: {}, enqueueLog });
  }
  expect(enqueueLog).toHaveBeenCalledTimes(detailsEnabled ? 3 : 0);
});
