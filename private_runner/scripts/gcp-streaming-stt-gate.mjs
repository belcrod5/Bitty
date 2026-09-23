import { once } from "node:events";
import { v2 as speech } from "@google-cloud/speech";
import { createGoogleCloudService } from "../src/google-cloud-service.mjs";

const LOCATION = "us";
const API_ENDPOINT = `${LOCATION}-speech.googleapis.com`;
const SAMPLE_RATE_HZ = 16_000;
const CHUNK_DURATION_MS = 100;
const CHUNK_BYTES = SAMPLE_RATE_HZ * 2 * CHUNK_DURATION_MS / 1_000;
const CHUNK_COUNT = 10;
const GATE_TIMEOUT_MS = 20_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function googleErrorReason(error) {
  if (typeof error?.reason === "string") return error.reason;
  for (const detail of Array.isArray(error?.statusDetails) ? error.statusDetails : []) {
    if (typeof detail?.reason === "string") return detail.reason;
  }
  return "unknown";
}

async function write(stream, request) {
  if (!stream.write(request)) await once(stream, "drain");
}

async function runGate() {
  const googleCloudService = createGoogleCloudService();
  const credentials = await googleCloudService.credentials();
  const client = new speech.SpeechClient({
    apiEndpoint: API_ENDPOINT,
    projectId: credentials.projectId,
    quotaProjectId: credentials.projectId,
    keyFilename: credentials.keyFilename,
  });
  const stream = client._streamingRecognize();
  let responseCount = 0;
  let timeout;

  const completed = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      stream.destroy(new Error("stream gate timed out"));
      reject(new Error(`stream gate timed out after ${GATE_TIMEOUT_MS}ms`));
    }, GATE_TIMEOUT_MS);
    stream.on("data", () => {
      responseCount += 1;
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });

  try {
    await write(stream, {
      recognizer: `projects/${credentials.projectId}/locations/${LOCATION}/recognizers/_`,
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: SAMPLE_RATE_HZ,
            audioChannelCount: 1,
          },
          languageCodes: ["ja-JP"],
          model: "chirp_3",
          features: {
            enableAutomaticPunctuation: true,
          },
        },
        streamingFeatures: {
          interimResults: true,
          enableVoiceActivityEvents: true,
        },
      },
    });

    const silence = Buffer.alloc(CHUNK_BYTES);
    for (let index = 0; index < CHUNK_COUNT; index += 1) {
      await write(stream, { audio: silence });
      await sleep(CHUNK_DURATION_MS);
    }
    stream.end();
    await completed;
    console.log(`GCP streaming STT gate passed (responses=${responseCount})`);
  } catch (error) {
    const code = Number.isFinite(Number(error?.code)) ? Number(error.code) : "unknown";
    const reason = googleErrorReason(error);
    const message = String(error?.message || "streaming recognition failed")
      .replace(/\s+/g, " ")
      .slice(0, 500);
    throw new Error(`code=${code} reason=${reason} message=${message}`);
  } finally {
    clearTimeout(timeout);
    stream.destroy();
    await client.close().catch(() => {});
  }
}

try {
  await runGate();
} catch (error) {
  console.error(`GCP streaming STT gate failed: ${error.message}`);
  process.exitCode = 1;
}
