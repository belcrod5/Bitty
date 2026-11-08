import { isRunnerSessionToken, requestRunnerLogin, RunnerLoginError } from "./runnerLogin";

const originalFetch = globalThis.fetch;
const fetchMock = jest.fn();
beforeEach(() => { globalThis.fetch = fetchMock; fetchMock.mockReset(); });
afterAll(() => { globalThis.fetch = originalFetch; });

test("accepts only versioned high entropy device sessions", () => {
  expect(isRunnerSessionToken("bitty_session_v1." + "a".repeat(43))).toBe(true);
  for (const value of ["runner-token", "bitty_session_v1.short", "bitty_session_v1." + "a".repeat(200), ""])
    expect(isRunnerSessionToken(value)).toBe(false);
});

test("login code requests cannot redirect and use only the selected origin", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ challengeId: "challenge" }) });
  await requestRunnerLogin("https://runner.test", "/auth/login/start", { body: { email: "owner@example.test", clientBinding: "binding" } });
  expect(fetchMock).toHaveBeenCalledWith("https://runner.test/auth/login/start", expect.objectContaining({ redirect: "error", method: "POST" }));
  expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined();
});

test.each(["http://remote.test", "https://user:password@runner.test", "https://runner.test/path", "https://runner.test/?token=secret"])(
  "rejects unsafe origin %s before sending codes", async (origin) => {
    await expect(requestRunnerLogin(origin, "/auth/login/start", { body: {} })).rejects.toThrow("invalid_runner_origin");
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("preserves auth error codes without exposing response bodies in errors", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "reauthentication_required", secret: "never print" }) });
  await expect(requestRunnerLogin("http://127.0.0.1:8788", "/auth/devices", { token: "session" }))
    .rejects.toEqual(new RunnerLoginError("reauthentication_required", 403));
});
