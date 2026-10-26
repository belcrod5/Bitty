import { getNetworkStateAsync } from "../networkState";

export type TtsAudioQuality = "standard" | "lightweight";

export async function resolveTtsAudioQuality(lightweightTtsOnCellular: boolean): Promise<TtsAudioQuality> {
  if (!lightweightTtsOnCellular) return "standard";
  try {
    return (await getNetworkStateAsync()).type === "CELLULAR" ? "lightweight" : "standard";
  } catch {
    return "standard";
  }
}
