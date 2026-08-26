import { render, waitFor } from "@testing-library/react-native";

import { RunnerFileExplorer } from "./RunnerFileExplorer";

afterEach(() => jest.restoreAllMocks());

test("aborts an in-flight directory request when the explorer becomes inactive", async () => {
  let requestSignal: AbortSignal | undefined;
  jest.spyOn(global, "fetch").mockImplementation((_url, init) => {
    requestSignal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  });
  const props = {
    runnerUrl: "http://runner",
    runnerToken: "token",
    rootPath: "/work",
    rootDisplayName: "Work",
    onFilePress: jest.fn(),
  };
  const view = await render(<RunnerFileExplorer {...props} active />);
  await waitFor(() => expect(requestSignal).toBeDefined());

  await view.rerender(<RunnerFileExplorer {...props} active={false} />);

  await waitFor(() => expect(requestSignal?.aborted).toBe(true));
});
