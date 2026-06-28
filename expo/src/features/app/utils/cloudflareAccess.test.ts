import { parseCloudflareRunnerPairingPayload } from "./cloudflareAccess";

const validPayload = {
  type: "bitty.runner.pairing",
  runnerUrl: "https://runner.example.com",
  runnerWsUrl: "wss://runner.example.com/runner-ws",
  runnerToken: "runner-secret",
  cloudflareAccessClientId: "access-id",
  cloudflareAccessClientSecret: "access-secret",
};

test("accepts HTTPS pairing with a same-origin WSS endpoint", () => {
  expect(parseCloudflareRunnerPairingPayload(JSON.stringify(validPayload))).toMatchObject({
    runnerUrl: "https://runner.example.com",
    runnerWsUrl: "wss://runner.example.com/runner-ws",
  });
});

test("rejects pairing secrets over plaintext HTTP", () => {
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    runnerUrl: "http://runner.example.com",
    runnerWsUrl: "ws://runner.example.com/runner-ws",
  }))).toThrow("HTTPS");
});

test("rejects a cross-origin WebSocket endpoint", () => {
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    runnerWsUrl: "wss://attacker.example.com/runner-ws",
  }))).toThrow("same-origin WSS");
});
