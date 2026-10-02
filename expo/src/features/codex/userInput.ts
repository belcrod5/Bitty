export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type UserInputRequest = {
  requestId: string;
  threadId: string;
  startedAtMs: number;
  questions: UserInputQuestion[];
};

export type UserInputResponse = { answers: Record<string, { answers: string[] }> };
