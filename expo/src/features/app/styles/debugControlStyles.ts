import { audioLabScreenStyles } from "./audioLabScreenStyles";
import { debugBaseStyles } from "./debugBaseStyles";
import { llmDebugStyles } from "./llmDebugStyles";
import { menuScreenStyles } from "./menuScreenStyles";
import { recordingDebugStyles } from "./recordingDebugStyles";

export const debugControlStyles = {
  ...menuScreenStyles,
  ...audioLabScreenStyles,
  ...debugBaseStyles,
  ...recordingDebugStyles,
  ...llmDebugStyles,
} as const;
