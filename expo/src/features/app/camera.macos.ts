import type { CameraViewProps } from "./camera.contract";

const deniedPermission = { granted: false };

export const supportsCamera = false;

export function useCameraPermissions() {
  return [deniedPermission, async () => deniedPermission] as const;
}

export function CameraView(_props: CameraViewProps) {
  return null;
}

export type { BarcodeScanningResult } from "./camera.contract";
