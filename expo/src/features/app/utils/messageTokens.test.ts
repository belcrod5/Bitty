import { formatOutputTokens } from "./messageTokens";

describe("message tokens", () => {
  it("shows a placeholder when measured usage is unavailable", () => {
    expect(formatOutputTokens()).toBe("-- tok");
    expect(formatOutputTokens(Number.NaN)).toBe("-- tok");
  });

  it("labels measured completion usage as a compact total", () => {
    expect(formatOutputTokens(0)).toBe("total 0 tok");
    expect(formatOutputTokens(999)).toBe("total 999 tok");
    expect(formatOutputTokens(1_000)).toBe("total 1k tok");
    expect(formatOutputTokens(1_500)).toBe("total 1.5k tok");
    expect(formatOutputTokens(999_949)).toBe("total 999.9k tok");
    expect(formatOutputTokens(999_950)).toBe("total 1m tok");
    expect(formatOutputTokens(999_999)).toBe("total 1m tok");
    expect(formatOutputTokens(1_000_000)).toBe("total 1m tok");
  });
});
