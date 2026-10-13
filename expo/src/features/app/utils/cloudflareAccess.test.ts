import { parseCloudflareRunnerPairingPayload } from "./cloudflareAccess";

const validPayload = {
  type: "bitty.runner.pairing",
  runnerUrl: "https://runner.example.com",
  localRunnerUrl: "https://d5-macbook.local:8789",
  localRunnerCertificate: "paired-ca",
  runnerToken: "runner-secret",
  cloudflareAccessClientId: "access-id",
  cloudflareAccessClientSecret: "access-secret",
};

test("accepts HTTPS runner origins and QR-paired local CA", () => {
  expect(parseCloudflareRunnerPairingPayload(JSON.stringify(validPayload))).toMatchObject({
    runnerUrl: "https://runner.example.com",
    localRunnerUrl: "https://d5-macbook.local:8789",
    localRunnerCertificate: "paired-ca",
  });
});

test("requires the current pairing contract", () => {
  const { type: _type, ...payloadWithoutType } = validPayload;
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify(payloadWithoutType))).toThrow("Unsupported QR payload type");
});

test("accepts local endpoints when .local host casing differs", () => {
  expect(parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    localRunnerUrl: "https://nakamurataigonoMac-mini.local:8789",
  }))).toMatchObject({
    localRunnerUrl: "https://nakamurataigonomac-mini.local:8789",
  });
});

test("rejects pairing secrets over plaintext HTTP", () => {
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    runnerUrl: "http://runner.example.com",
  }))).toThrow("HTTPS");
});

test("rejects a non-HTTPS local runner origin", () => {
  expect(() => parseCloudflareRunnerPairingPayload(JSON.stringify({
    ...validPayload,
    localRunnerUrl: "ftp://d5-macbook.local:8788",
  }))).toThrow("local runner requires an HTTPS origin");
});

test("legacy HTTP QR pairs only Cloudflare and discards local trust", () => {
  expect(parseCloudflareRunnerPairingPayload(JSON.stringify({ ...validPayload,
    localRunnerUrl: "http://mac.local:8788" }))).toMatchObject({
    runnerUrl: validPayload.runnerUrl, localRunnerUrl: "", localRunnerCertificate: "",
  });
});
