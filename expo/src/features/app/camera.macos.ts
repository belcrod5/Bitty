const deniedPermission = { granted: false };

export const supportsCamera = false;

export function useCameraPermissions() {
  return [deniedPermission, async () => deniedPermission] as const;
}

export function CameraView() {
  return null;
}
