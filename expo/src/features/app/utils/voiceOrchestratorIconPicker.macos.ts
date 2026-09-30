import { NativeModules } from "react-native";

export const supportsVoiceOrchestratorIconPicking = true;

export async function pickVoiceOrchestratorIcon(): Promise<string | null> {
  const picker = NativeModules.BittyIconPicker as { pick?: () => Promise<string | null> } | undefined;
  if (!picker?.pick) throw new Error("画像選択を使うには macOS アプリを更新してください。");
  return picker.pick();
}
