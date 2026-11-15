import { runnerSettingsRequest } from "./runnerSettingsRequest";

test("preserves the Runner HTTP status for safe correction diagnostics", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: false, status: 502, json: async () => ({ error: "stt_correction_failed" }),
  } as Response);
  try {
    await expect(runnerSettingsRequest("https://runner.test", "token", "/stt/correct"))
      .rejects.toMatchObject({ message: "Runner request failed (502).", status: 502 });
  } finally {
    fetchMock.mockRestore();
  }
});
