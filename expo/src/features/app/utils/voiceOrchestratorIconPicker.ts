import * as ImagePicker from "expo-image-picker";

export const supportsVoiceOrchestratorIconPicking = true;

export async function pickVoiceOrchestratorIcon(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"], allowsMultipleSelection: false,
    allowsEditing: true, aspect: [1, 1], quality: 0.4, base64: true,
  });
  if (result.canceled) return null;
  const base64 = result.assets[0]?.base64;
  if (!base64) throw new Error("画像を読み込めません。");
  if (base64.length > 1_400_000) throw new Error("画像は 1 MB 以下にしてください。");
  const mime = base64.startsWith("iVBOR") ? "image/png"
    : base64.startsWith("/9j/") ? "image/jpeg"
      : base64.startsWith("UklG") ? "image/webp" : "";
  if (!mime) throw new Error("PNG・JPEG・WebP の画像を選んでください。");
  return `data:${mime};base64,${base64}`;
}
