import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { PickWorkspaceUploadAsset } from "./workspaceUploadPicker.contract";

export const supportsWorkspaceFilePicking = true;

export const pickWorkspaceUploadAsset: PickWorkspaceUploadAsset = async (source) => {
  if (source === "photos") {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset?.uri) return null;
    return {
      uri: asset.uri,
      name: String(asset.fileName || "").trim(),
      mimeType: String(asset.mimeType || "image/png").trim() || "image/png",
      size: asset.fileSize,
    };
  }

  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset?.uri) return null;
  return {
    uri: asset.uri,
    name: String(asset.name || "").trim(),
    mimeType: String(asset.mimeType || "application/octet-stream").trim()
      || "application/octet-stream",
    size: asset.size,
  };
};
