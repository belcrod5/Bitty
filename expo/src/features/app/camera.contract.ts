import type { ComponentProps } from "react";
import type { CameraView as ExpoCameraView } from "expo-camera";

export type CameraViewProps = ComponentProps<typeof ExpoCameraView>;
export type { BarcodeScanningResult } from "expo-camera";
