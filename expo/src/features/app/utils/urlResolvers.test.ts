import {
  suggestCodexWsUrlFromRunnerUrl,
  suggestRunnerWsUrlFromRunnerUrl,
} from "./urlResolvers";

test("runner websocket URL suggestions do not put tokens in query strings", () => {
  expect(suggestRunnerWsUrlFromRunnerUrl("https://bitty-runner.example.com")).toBe(
    "wss://bitty-runner.example.com/runner-ws"
  );
  expect(suggestCodexWsUrlFromRunnerUrl("https://bitty-runner.example.com")).toBe(
    "wss://bitty-runner.example.com/codex-ws"
  );
});
