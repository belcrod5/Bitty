export function isValidUserInputResponse(params, result) {
  const answers = result?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;
  const questionIds = new Set((params?.questions || []).map((question) => question.id));
  return Object.entries(answers).every(([id, answer]) => questionIds.has(id)
    && Array.isArray(answer?.answers)
    && answer.answers.every((value) => typeof value === "string"));
}
