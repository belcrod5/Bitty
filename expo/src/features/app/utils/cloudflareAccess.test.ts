import { parseCloudflareRunnerPairingPayload } from "./cloudflareAccess";

const validPayload = {
  type: "bitty.runner.pairing",
  runnerUrl: "https://runner.example.com",
  localRunnerUrl: "http://d5-macbook.local:8788",
  runnerToken: "runner-secret",
  cloudflareAccessClientId: "access-id",
  cloudflareAccessClientSecret: "access-secret",
};

test("accepts HTTPS and local HTTP runner origins", () => {
  expect(parseCloudflareRunnerPairingPayload(JSON.stringify(validPayload))).toMatchObject({
    runnerUrl: "https://runner.example.com",
    localRunnerUrl: "http://d5-macbook.local:8788",
  });
});

test("requires the current pairing contract", () => {
  const { type: _type, ...payloadWithoutType } = validPayload;
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify(payloadWithoutType))).toThrow("Unsupported QR payload type");
});

test("accepts local endpoints when .local host casing differs", () => {
  expect(parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    localRunnerUrl: "http://nakamurataigonoMac-mini.local:8788",
  }))).toMatchObject({
    localRunnerUrl: "http://nakamurataigonomac-mini.local:8788",
  });
});

test("rejects pairing secrets over plaintext HTTP", () => {
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    runnerUrl: "http://runner.example.com",
  }))).toThrow("HTTPS");
});

test("rejects a non-HTTP local runner origin", () => {
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    localRunnerUrl: "https://d5-macbook.local:8788",
  }))).toThrow("local runner requires an HTTP origin");
});
