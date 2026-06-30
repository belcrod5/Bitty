import { parseCloudflareRunnerPairingPayload } from "./cloudflareAccess";

const validPayload = {
  type: "bitty.runner.pairing",
  runnerUrl: "https://runner.example.com",
  runnerWsUrl: "wss://runner.example.com/runner-ws",
  localRunnerUrl: "http://d5-macbook.local:8788",
  localRunnerWsUrl: "ws://d5-macbook.local:8788/runner-ws",
  runnerToken: "runner-secret",
  cloudflareAccessClientId: "access-id",
  cloudflareAccessClientSecret: "access-secret",
};

test("accepts HTTPS pairing with a same-origin WSS endpoint", () => {
  expect(parseCloudflareRunnerPairingPayload(JSON.stringify(validPayload))).toMatchObject({
    runnerUrl: "https://runner.example.com",
    runnerWsUrl: "wss://runner.example.com/runner-ws",
    localRunnerUrl: "http://d5-macbook.local:8788",
    localRunnerWsUrl: "ws://d5-macbook.local:8788/runner-ws",
  });
});

test("accepts local endpoints when .local host casing differs", () => {
  expect(parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    localRunnerUrl: "http://nakamurataigonoMac-mini.local:8788",
    localRunnerWsUrl: "ws://nakamurataigonomac-mini.local:8788/runner-ws",
  }))).toMatchObject({
    localRunnerUrl: "http://nakamurataigonomac-mini.local:8788",
    localRunnerWsUrl: "ws://nakamurataigonomac-mini.local:8788/runner-ws",
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

test("rejects local endpoints that do not share an origin", () => {
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    localRunnerWsUrl: "ws://other-mac.local:8788/runner-ws",
  }))).toThrow("same-origin WS");
});
