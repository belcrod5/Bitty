import type { ReasoningEffort } from "../app/utils/settingsParsers";

export type LocationScheduleSettingsProps = {
  currentCwd: string;
  currentModelRef: string;
  currentReasoningEffort: ReasoningEffort;
  directories: readonly { path: string; displayName: string }[];
  modelOptions: readonly { value: string; label: string }[];
  thinkOptions: readonly ReasoningEffort[];
};
