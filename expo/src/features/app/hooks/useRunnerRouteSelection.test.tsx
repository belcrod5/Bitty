import React from "react";
import { act, render } from "@testing-library/react-native";
import { AppState } from "react-native";
import * as Network from "expo-network";
import { useRunnerRouteSelection } from "./useRunnerRouteSelection";

jest.mock("expo-network", () => ({
  addNetworkStateListener: jest.fn(),
}));

const localRunnerUrl = "http://d5-macbook.local:8788";
const localRunnerWsUrl = "ws://d5-macbook.local:8788/runner-ws";
const cloudflareRunnerUrl = "https://runner.example.com";
const cloudflareRunnerWsUrl = "wss://runner.example.com/runner-ws";
const runnerToken = "runner-secret";
type RouteSelectionProps = Parameters<typeof useRunnerRouteSelection>[0];
type RouteSelectionResult = ReturnType<typeof useRunnerRouteSelection>;
let latestRouteSelection: RouteSelectionResult | null = null;

function RouteSelectionProbe(props: RouteSelectionProps) {
  latestRouteSelection = useRunnerRouteSelection(props);
  return null;
}

describe("useRunnerRouteSelection", () => {
  const appStateListeners: Array<(state: "active" | "background" | "inactive") => void> = [];
  const networkListeners: Array<() => void> = [];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.clearAllMocks();
    appStateListeners.length = 0;
    networkListeners.length = 0;
    latestRouteSelection = null;
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true } as Response);
    jest.mocked(Network.addNetworkStateListener).mockImplementation((listener) => {
      networkListeners.push(listener as () => void);
      return { remove: jest.fn() };
    });
    jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
      appStateListeners.push(listener as (state: "active" | "background" | "inactive") => void);
      return { remove: jest.fn() };
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function runPendingTimers() {
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function advanceTimers(ms: number) {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function renderSelection(overrides: Partial<Parameters<typeof useRunnerRouteSelection>[0]> = {}) {
    const setRunnerUrl = jest.fn();
    const setCodexWsUrl = jest.fn();
    const props: RouteSelectionProps = {
      enabled: true,
      localRunnerUrl,
      localRunnerWsUrl,
      cloudflareRunnerUrl,
      cloudflareRunnerWsUrl,
      runnerToken,
      runnerUrl: cloudflareRunnerUrl,
      codexWsUrl: cloudflareRunnerWsUrl,
      setRunnerUrl,
      setCodexWsUrl,
      ...overrides,
    };
    const rendered = await render(<RouteSelectionProbe {...props} />);
    await act(async () => {
      await Promise.resolve();
    });
    return { rendered, setRunnerUrl, setCodexWsUrl };
  }

  function resolveFetchLater() {
    let resolveResponse: (value: Response) => void = () => undefined;
    const promise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    return { promise, resolveResponse };
  }

  it("checks local health with the runner token and switches to local when reachable", async () => {
    const { setRunnerUrl, setCodexWsUrl } = await renderSelection();

    await runPendingTimers();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${localRunnerUrl}/health`, expect.objectContaining({
      method: "GET",
      headers: { Authorization: `Bearer ${runnerToken}` },
    }));
    expect(setRunnerUrl).toHaveBeenCalledWith(localRunnerUrl);
    expect(setCodexWsUrl).toHaveBeenCalledWith(localRunnerWsUrl);
  });

  it("rechecks when a local runner candidate is saved after startup", async () => {
    const { rendered, setRunnerUrl, setCodexWsUrl } = await renderSelection({
      localRunnerUrl: "",
      localRunnerWsUrl: "",
    });

    await runPendingTimers();

    expect(fetch).not.toHaveBeenCalled();

    await rendered.rerender(<RouteSelectionProbe
      enabled={true}
      localRunnerUrl={localRunnerUrl}
      localRunnerWsUrl={localRunnerWsUrl}
      cloudflareRunnerUrl={cloudflareRunnerUrl}
      cloudflareRunnerWsUrl={cloudflareRunnerWsUrl}
      runnerToken={runnerToken}
      runnerUrl={cloudflareRunnerUrl}
      codexWsUrl={cloudflareRunnerWsUrl}
      setRunnerUrl={setRunnerUrl}
      setCodexWsUrl={setCodexWsUrl}
    />);

    await runPendingTimers();

    expect(fetch).toHaveBeenCalledWith(`${localRunnerUrl}/health`, expect.objectContaining({
      headers: { Authorization: `Bearer ${runnerToken}` },
    }));
    expect(setRunnerUrl).toHaveBeenCalledWith(localRunnerUrl);
    expect(setCodexWsUrl).toHaveBeenCalledWith(localRunnerWsUrl);
  });

  it("rechecks again after a network event so local can win once Wi-Fi stabilizes", async () => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    const { setRunnerUrl, setCodexWsUrl } = await renderSelection();

    await runPendingTimers();
    expect(setRunnerUrl).not.toHaveBeenCalled();

    jest.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    networkListeners[0]?.();

    await advanceTimers(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(setRunnerUrl).not.toHaveBeenCalled();

    await advanceTimers(1500);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(setRunnerUrl).toHaveBeenCalledWith(localRunnerUrl);
    expect(setCodexWsUrl).toHaveBeenCalledWith(localRunnerWsUrl);

    await advanceTimers(3000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the network retry window when a WebSocket problem follows the network event", async () => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    const { setRunnerUrl, setCodexWsUrl } = await renderSelection();

    await runPendingTimers();
    expect(setRunnerUrl).not.toHaveBeenCalled();

    jest.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    networkListeners[0]?.();
    latestRouteSelection?.requestRouteRecheck();

    await advanceTimers(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(setRunnerUrl).not.toHaveBeenCalled();

    await advanceTimers(1500);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(setRunnerUrl).toHaveBeenCalledWith(localRunnerUrl);
    expect(setCodexWsUrl).toHaveBeenCalledWith(localRunnerWsUrl);
  });

  it("ignores an old in-flight health result after a newer network event is scheduled", async () => {
    const firstHealth = resolveFetchLater();
    jest.mocked(fetch).mockImplementationOnce(() => firstHealth.promise);
    const { setRunnerUrl, setCodexWsUrl } = await renderSelection();

    await advanceTimers(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    networkListeners[0]?.();
    await act(async () => {
      firstHealth.resolveResponse({ ok: true } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setRunnerUrl).not.toHaveBeenCalled();
    expect(setCodexWsUrl).not.toHaveBeenCalled();

    await advanceTimers(500);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(setRunnerUrl).toHaveBeenCalledWith(localRunnerUrl);
    expect(setCodexWsUrl).toHaveBeenCalledWith(localRunnerWsUrl);
  });

});
