import type { ReasoningEffort } from "../app/utils/settingsParsers";

export type CodexScheduleSettingsProps = {
  runnerUrl: string;
  runnerToken: string;
  currentCwd: string;
  currentModelRef: string;
  currentReasoningEffort: ReasoningEffort;
  currentThreadId: string;
  directories: readonly { path: string; displayName: string }[];
  modelOptions: readonly { value: string; label: string }[];
  thinkOptions: readonly ReasoningEffort[];
};
