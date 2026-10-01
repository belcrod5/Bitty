import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react-native";
import { useVoiceApprovals } from "./useVoiceApprovals";
import { RunnerWebSocketManager } from "../../runnerWs/RunnerWebSocketManager";
import { RunnerWebSocketProvider } from "../../runnerWs/RunnerWebSocketContext";

test("app approval listener uses its root manager outside the provider", async () => {
  const manager = new RunnerWebSocketManager({ bootstrapReady: false, url: "", token: "", appState: "unknown" });
  const subscribe = jest.spyOn(manager, "subscribe");
  const wrapper = ({ children }: { children: ReactNode }) => <>
    {children}
    <RunnerWebSocketProvider bootstrapReady={false} url="" token="" cloudflareRunnerUrl=""
      cloudflareAccessClientId="" cloudflareAccessClientSecret="" manager={manager}>
      <></>
    </RunnerWebSocketProvider>
  </>;
  const view = await renderHook(() => useVoiceApprovals(undefined, undefined, manager), { wrapper });

  expect(subscribe).toHaveBeenCalledWith({ channel: "agent", op: "voice.approval.request" }, expect.any(Function));
  await view.unmount();
});
