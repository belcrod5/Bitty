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

function RouteSelectionProbe(props: RouteSelectionProps) {
  useRunnerRouteSelection(props);
  return null;
}

describe("useRunnerRouteSelection", () => {
  const appStateListeners: Array<(state: "active" | "background" | "inactive") => void> = [];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllTimers();
    jest.clearAllMocks();
    appStateListeners.length = 0;
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true } as Response);
    jest.mocked(Network.addNetworkStateListener).mockImplementation((listener) => {
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

});
