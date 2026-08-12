import { Clipboard } from "react-native";
import type {
  ClipboardImage,
  GetImageOptions,
  GetStringOptions,
  SetStringOptions,
} from "expo-clipboard";

export function getStringAsync(_options?: GetStringOptions): Promise<string> {
  return Clipboard.getString();
}

export async function setStringAsync(
  text: string,
  _options?: SetStringOptions
): Promise<boolean> {
  Clipboard.setString(text);
  return true;
}

export async function hasImageAsync(): Promise<boolean> {
  return false;
}

export async function getImageAsync(
  _options: GetImageOptions
): Promise<ClipboardImage | null> {
  return null;
}
