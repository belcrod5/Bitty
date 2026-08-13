export type WorkspaceUploadPickerSource = "photos" | "files";

export type WorkspaceUploadPickerAsset = {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
};

export type PickWorkspaceUploadAsset = (
  source: WorkspaceUploadPickerSource
) => Promise<WorkspaceUploadPickerAsset | null>;
