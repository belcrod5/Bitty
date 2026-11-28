import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { useRunnerSessionLifecycle } from "./useRunnerSessionLifecycle";
import { clearSecureRunnerSession } from "../utils/secureRunnerCredentials";
import { requestRunnerLogin, RunnerLoginError } from "../utils/runnerLogin";

jest.mock("../utils/secureRunnerCredentials", () => ({ clearSecureRunnerSession: jest.fn(async () => true) }));
jest.mock("../utils/runnerLogin", () => ({ ...jest.requireActual("../utils/runnerLogin"), requestRunnerLogin: jest.fn() }));
const requestMock = jest.mocked(requestRunnerLogin);
const clearMock = jest.mocked(clearSecureRunnerSession);
const SESSION_A = "bitty_session_v1." + "a".repeat(43);
const SESSION_B = "bitty_session_v1." + "b".repeat(43);
const setRunnerToken = jest.fn();
const onLoginRequired = jest.fn();
const props = (token = SESSION_A) => ({ settingsLoaded: true, runnerUrl: "https://runner.test", runnerToken: token, setRunnerToken, onLoginRequired });
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
  requestMock.mockResolvedValue({ sessionId: "session", ownerEmail: "owner@example.test", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
});

test("without a device session, opens login without trying legacy credentials", async () => {
  await renderHook(() => useRunnerSessionLifecycle(props("")));
  expect(onLoginRequired).toHaveBeenCalledTimes(1);
  expect(requestMock).not.toHaveBeenCalled();
});

test("a server-confirmed expired session blocks clients and conditionally clears Keychain", async () => {
  requestMock.mockRejectedValue(new RunnerLoginError("authentication_required", 401));
  await renderHook(() => useRunnerSessionLifecycle(props()));
  await waitFor(() => expect(clearMock).toHaveBeenCalledWith(SESSION_A));
  expect(onLoginRequired).toHaveBeenCalled();
  expect(setRunnerToken.mock.calls[0][0](SESSION_A)).toBe("");
  expect(setRunnerToken.mock.calls[0][0](SESSION_B)).toBe(SESSION_B);
});

test("an old verification cannot invalidate a later login", async () => {
  let reject!: (reason: unknown) => void;
  requestMock.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
  const hook = await renderHook((input: ReturnType<typeof props>) => useRunnerSessionLifecycle(input), { initialProps: props() });
  await hook.rerender(props(SESSION_B));
  expect(requestMock).toHaveBeenCalledTimes(2);
  await act(async () => reject(new RunnerLoginError("authentication_required", 401)));
  expect(clearMock).not.toHaveBeenCalled();
  expect(setRunnerToken).not.toHaveBeenCalled();
});

test("Cloudflare failure and network failure keep credentials for retry", async () => {
  requestMock.mockRejectedValue(new RunnerLoginError("unauthorized", 401));
  const hook = await renderHook(() => useRunnerSessionLifecycle(props()));
  await act(async () => {});
  expect(hook.result.current.verified).toBe(false);
  expect(clearMock).not.toHaveBeenCalled();
  expect(setRunnerToken).not.toHaveBeenCalled();
});

test("cold startup does not admit cached private content until the current origin and token are verified", async () => {
  let resolve!: (value: unknown) => void;
  requestMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const hook = await renderHook((input: ReturnType<typeof props>) => useRunnerSessionLifecycle(input), { initialProps: props() });
  expect(hook.result.current.verified).toBe(false);
  await act(async () => resolve({ sessionId: "session", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  expect(hook.result.current.verified).toBe(true);
  requestMock.mockImplementationOnce(() => new Promise(() => {}));
  await hook.rerender(props(SESSION_B));
  expect(hook.result.current.verified).toBe(false);
});

test("expired verification proof closes the gate and requires a new server confirmation", async () => {
  jest.useFakeTimers();
  requestMock.mockResolvedValueOnce({ sessionId: "session", expiresAt: new Date(Date.now() + 5_000).toISOString() });
  const hook = await renderHook(() => useRunnerSessionLifecycle(props()));
  await act(async () => {});
  expect(hook.result.current.verified).toBe(true);
  await act(async () => jest.advanceTimersByTime(5_000));
  expect(hook.result.current.verified).toBe(false);
  await hook.unmount(); jest.useRealTimers();
});

test("returning to foreground revalidates a session used by native background clients", async () => {
  let onChange!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  const spy = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    onChange = listener; return { remove };
  });
  const hook = await renderHook(() => useRunnerSessionLifecycle(props()));
  await act(async () => {});
  requestMock.mockRejectedValueOnce(new RunnerLoginError("authentication_required", 401));
  await act(async () => onChange("active"));
  expect(clearMock).toHaveBeenCalledWith(SESSION_A);
  await hook.unmount(); expect(remove).toHaveBeenCalled(); spy.mockRestore();
});

const pairedProps = (runnerUrl = "https://runner.test") => ({
  ...props(), runnerUrl, localRunnerUrl: "https://runner.local", cloudflareRunnerUrl: "https://runner.test",
});

test("switching between paired routes keeps the verified session while rechecking the new route", async () => {
  let reject!: (reason: unknown) => void;
  const hook = await renderHook((input: ReturnType<typeof pairedProps>) => useRunnerSessionLifecycle(input), { initialProps: pairedProps() });
  await act(async () => {});
  expect(hook.result.current.verified).toBe(true);
  requestMock.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
  await hook.rerender(pairedProps("https://runner.local"));
  expect(hook.result.current.verified).toBe(true);
  expect(requestMock).toHaveBeenLastCalledWith("https://runner.local", "/auth/session", { token: SESSION_A });
  await act(async () => reject(new Error("network unavailable")));
  expect(hook.result.current.verified).toBe(true);
  expect(clearMock).not.toHaveBeenCalled();
});

test.each([
  { runnerUrl: "https://other-runner.test" },
  { localRunnerUrl: "https://new-runner.local" },
  { cloudflareRunnerUrl: "https://new-runner.test" },
])("a different Runner or pairing configuration requires fresh proof: %j", async (change) => {
  const hook = await renderHook((input: ReturnType<typeof pairedProps>) => useRunnerSessionLifecycle(input), { initialProps: pairedProps() });
  await act(async () => {});
  expect(hook.result.current.verified).toBe(true);
  requestMock.mockImplementationOnce(() => new Promise(() => {}));
  await hook.rerender({ ...pairedProps(), ...change });
  expect(hook.result.current.verified).toBe(false);
});

test("route changes do not cancel the existing session expiry when rechecking fails", async () => {
  jest.useFakeTimers();
  requestMock.mockResolvedValueOnce({ sessionId: "session", expiresAt: new Date(Date.now() + 5_000).toISOString() });
  const hook = await renderHook((input: ReturnType<typeof pairedProps>) => useRunnerSessionLifecycle(input), { initialProps: pairedProps() });
  await act(async () => {});
  requestMock.mockRejectedValueOnce(new Error("network unavailable"));
  await hook.rerender(pairedProps("https://runner.local"));
  expect(hook.result.current.verified).toBe(true);
  await act(async () => jest.advanceTimersByTime(5_000));
  expect(hook.result.current.verified).toBe(false);
  expect(clearMock).toHaveBeenCalledWith(SESSION_A);
  await hook.unmount(); jest.useRealTimers();
});

test("an explicit auth rejection after a paired route switch still revokes the session", async () => {
  const hook = await renderHook((input: ReturnType<typeof pairedProps>) => useRunnerSessionLifecycle(input), { initialProps: pairedProps() });
  await act(async () => {});
  requestMock.mockRejectedValueOnce(new RunnerLoginError("authentication_required", 401));
  await hook.rerender(pairedProps("https://runner.local"));
  await act(async () => {});
  expect(hook.result.current.verified).toBe(false);
  expect(clearMock).toHaveBeenCalledWith(SESSION_A);
});

test("a stale auth rejection cannot revoke a different Runner using the same saved token", async () => {
  let reject!: (reason: unknown) => void;
  requestMock.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
  const hook = await renderHook((input: ReturnType<typeof pairedProps>) => useRunnerSessionLifecycle(input), { initialProps: pairedProps() });
  await hook.rerender(pairedProps("https://other-runner.test"));
  await act(async () => {});
  expect(hook.result.current.verified).toBe(true);
  await act(async () => reject(new RunnerLoginError("authentication_required", 401)));
  expect(hook.result.current.verified).toBe(true);
  expect(clearMock).not.toHaveBeenCalled();
});
