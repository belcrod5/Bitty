import React from "react";
import { act, render } from "@testing-library/react-native";
import { AppState, NativeModules, Platform } from "react-native";
import * as Network from "expo-network";
import { configureLocalRunnerTls } from "../utils/localRunnerTls";
import { useRunnerRouteSelection } from "./useRunnerRouteSelection";

jest.mock("expo-network", () => ({
  addNetworkStateListener: jest.fn(),
}));

const localRunnerUrl = "https://d5-macbook.local:8789";
const cloudflareRunnerUrl = "https://runner.example.com";
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

  beforeEach(async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    NativeModules.BittyRunnerTLS = { configure: jest.fn().mockResolvedValue(undefined) };
    await configureLocalRunnerTls(localRunnerUrl, "paired-ca");
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
    const props: RouteSelectionProps = {
      enabled: true,
      localRunnerUrl,
      localRunnerCertificate: "paired-ca",
      cloudflareRunnerUrl,
      runnerToken,
      runnerUrl: cloudflareRunnerUrl,
      setRunnerUrl,
      ...overrides,
    };
    const rendered = await render(<RouteSelectionProbe {...props} />);
    await act(async () => {
      await Promise.resolve();
    });
    return { rendered, setRunnerUrl };
  }

  function resolveFetchLater() {
    let resolveResponse: (value: Response) => void = () => undefined;
    const promise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    return { promise, resolveResponse };
  }

  it("checks local health with the runner token and switches to local when reachable", async () => {
    const { setRunnerUrl } = await renderSelection();

    await runPendingTimers();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${localRunnerUrl}/health`, expect.objectContaining({
      method: "GET",
      headers: { Authorization: `Bearer ${runnerToken}` },
    }));
    expect(setRunnerUrl).toHaveBeenCalledWith(localRunnerUrl);
  });

  it("never probes a legacy plaintext LAN candidate even if a host returns 200", async () => {
    const { setRunnerUrl } = await renderSelection({ localRunnerUrl: "http://d5-macbook.local:8788" });
    await runPendingTimers();
    networkListeners[0]?.();
    await advanceTimers(5000);
    expect(fetch).not.toHaveBeenCalled();
    expect(setRunnerUrl).not.toHaveBeenCalled();
  });

  it("selects the only macOS loopback candidate without a Cloudflare probe", async () => {
    jest.replaceProperty(Platform, "OS", "macos");
    const local = "http://127.0.0.1:8788";
    const { setRunnerUrl } = await renderSelection({ localRunnerUrl: local, cloudflareRunnerUrl: "", runnerUrl: "" });
    await runPendingTimers();
    expect(setRunnerUrl).toHaveBeenCalledWith(local);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("selects macOS loopback over Cloudflare when reachable", async () => {
    jest.replaceProperty(Platform, "OS", "macos");
    const local = "http://127.0.0.1:8788";
    const { setRunnerUrl } = await renderSelection({ localRunnerUrl: local });
    await runPendingTimers();
    expect(fetch).toHaveBeenCalledWith(`${local}/health`, expect.objectContaining({
      headers: { Authorization: `Bearer ${runnerToken}` },
    }));
    expect(setRunnerUrl).toHaveBeenCalledWith(local);
  });

  it("does not probe iOS loopback HTTP", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { setRunnerUrl } = await renderSelection({ localRunnerUrl: "http://127.0.0.1:8788" });
    await runPendingTimers();
    expect(fetch).not.toHaveBeenCalled();
    expect(setRunnerUrl).not.toHaveBeenCalled();
  });

  it.each(["", "http://192.168.1.5:8788"])("discards an old probe and selection after editing local URL to %s", async (nextLocal) => {
    const oldHealth = resolveFetchLater();
    jest.mocked(fetch).mockImplementationOnce(() => oldHealth.promise);
    const { rendered, setRunnerUrl } = await renderSelection();
    await advanceTimers(0);
    await rendered.rerender(<RouteSelectionProbe enabled={true}
      localRunnerUrl={nextLocal} localRunnerCertificate="paired-ca"
      cloudflareRunnerUrl="" runnerToken={runnerToken}
      runnerUrl={localRunnerUrl} setRunnerUrl={setRunnerUrl} />);
    await act(async () => {
      oldHealth.resolveResponse({ ok: true } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    await runPendingTimers();
    expect(setRunnerUrl).toHaveBeenCalledWith("");
    expect(setRunnerUrl).not.toHaveBeenCalledWith(localRunnerUrl);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not clear a persisted selection while settings are loading", async () => {
    const { rendered, setRunnerUrl } = await renderSelection({ enabled: false, localRunnerUrl: "" });
    await rendered.rerender(<RouteSelectionProbe enabled={false}
      localRunnerUrl={localRunnerUrl} localRunnerCertificate="paired-ca"
      cloudflareRunnerUrl={cloudflareRunnerUrl} runnerToken={runnerToken}
      runnerUrl={localRunnerUrl} setRunnerUrl={setRunnerUrl} />);
    await runPendingTimers();
    expect(setRunnerUrl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks when a local runner candidate is saved after startup", async () => {
    const { rendered, setRunnerUrl } = await renderSelection({
      localRunnerUrl: "",
    });

    await runPendingTimers();

    expect(fetch).not.toHaveBeenCalled();

    await rendered.rerender(<RouteSelectionProbe
      enabled={true}
      localRunnerUrl={localRunnerUrl}
      localRunnerCertificate="paired-ca"
      cloudflareRunnerUrl={cloudflareRunnerUrl}
      runnerToken={runnerToken}
      runnerUrl={cloudflareRunnerUrl}
      setRunnerUrl={setRunnerUrl}
    />);

    await runPendingTimers();

    expect(fetch).toHaveBeenCalledWith(`${localRunnerUrl}/health`, expect.objectContaining({
      headers: { Authorization: `Bearer ${runnerToken}` },
    }));
    expect(setRunnerUrl).toHaveBeenCalledWith(localRunnerUrl);
  });

  it("rechecks when the Cloudflare runner candidate changes", async () => {
    jest.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    const { rendered, setRunnerUrl } = await renderSelection();

    await runPendingTimers();
    expect(setRunnerUrl).not.toHaveBeenCalled();

    const nextCloudflareRunnerUrl = "https://next-runner.example.com";
    await rendered.rerender(<RouteSelectionProbe
      enabled={true}
      localRunnerUrl={localRunnerUrl}
      localRunnerCertificate="paired-ca"
      cloudflareRunnerUrl={nextCloudflareRunnerUrl}
      runnerToken={runnerToken}
      runnerUrl={cloudflareRunnerUrl}
      setRunnerUrl={setRunnerUrl}
    />);

    await runPendingTimers();

    expect(setRunnerUrl).toHaveBeenCalledWith(nextCloudflareRunnerUrl);
  });

  it("rechecks again after a network event so local can win once Wi-Fi stabilizes", async () => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    const { setRunnerUrl } = await renderSelection();

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

    await advanceTimers(3000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the network retry window when a WebSocket problem follows the network event", async () => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    const { setRunnerUrl } = await renderSelection();

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
  });

  it("ignores an old in-flight health result after a newer network event is scheduled", async () => {
    const firstHealth = resolveFetchLater();
    jest.mocked(fetch).mockImplementationOnce(() => firstHealth.promise);
    const { setRunnerUrl } = await renderSelection();

    await advanceTimers(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    networkListeners[0]?.();
    await act(async () => {
      firstHealth.resolveResponse({ ok: true } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setRunnerUrl).not.toHaveBeenCalled();

    await advanceTimers(500);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(setRunnerUrl).toHaveBeenCalledWith(localRunnerUrl);
  });

});
