jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "11111111-2222-4333-8444-555555555555"),
}));

const { createCodexRunnerWsLogicalId } = require("./runnerWsJsonRpcIds");
const { randomUUID } = require("expo-crypto");

test("creates logical operation capability IDs with the platform CSPRNG", () => {
  expect(createCodexRunnerWsLogicalId("codex_turn_op", "trace/1")).toBe(
    "codex_turn_op_trace_1_11111111-2222-4333-8444-555555555555"
  );
  expect(randomUUID).toHaveBeenCalledTimes(1);
});
