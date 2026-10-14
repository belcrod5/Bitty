import {
  buildRunnerMediaFileUrl,
  getRunnerMediaSource,
  resolveRunnerMarkdownImage,
} from "./runnerFileResources";
import { configureCloudflareAccessFetch } from "./cloudflareAccessFetch";

const context = { runnerUrl: "http://runner.test", runnerToken: "token", rootDir: "/repo" };

describe("Runner image resources", () => {
  beforeEach(() => configureCloudflareAccessFetch({ runnerUrl: "", credentials: { clientId: "", clientSecret: "" } }));

  it("includes Access credentials only in sources for the configured Runner origin", () => {
    configureCloudflareAccessFetch({ runnerUrl: "https://runner.test", credentials: { clientId: "access-id", clientSecret: "access-secret" } });
    const cloud = { ...context, runnerUrl: "https://runner.test" };
    const source = resolveRunnerMarkdownImage("/private/tmp/image.jpg", cloud)!;
    expect(source.headers).toEqual({ authorization: "Bearer token", "CF-Access-Client-Id": "access-id", "CF-Access-Client-Secret": "access-secret" });
    expect(getRunnerMediaSource(source.uri, context.runnerToken)).toEqual(source);
    expect(resolveRunnerMarkdownImage("https://runner.test/external.jpg", cloud)).toEqual({ uri: "https://runner.test/external.jpg" });
    expect(resolveRunnerMarkdownImage("image.jpg", { ...cloud, runnerUrl: "https://runner.test:9443" })!.headers)
      .toEqual({ authorization: "Bearer token" });
    expect(resolveRunnerMarkdownImage("image.jpg", { ...cloud, runnerUrl: "https://local.test" })!.headers)
      .toEqual({ authorization: "Bearer token" });
    configureCloudflareAccessFetch({ runnerUrl: "https://runner.test", credentials: { clientId: "access-id", clientSecret: "rotated-secret" } });
    expect(resolveRunnerMarkdownImage("/private/tmp/image.jpg", cloud)!.headers!["CF-Access-Client-Secret"])
      .toBe("rotated-secret");
  });
  it.each([
    ["/private/tmp/screen.jpg", "/private/tmp"],
    ["/repo/images/screen.jpg", "/repo"],
    ["images/screen.jpg", "/repo"],
    ["/repo/../tmp/screen.jpg", "/repo/../tmp"],
    ["/screen.jpg", "/"],
  ])("resolves the actual root for %s in the shared media URL", (path, rootDir) => {
    const url = new URL(buildRunnerMediaFileUrl({ ...context, path }));
    expect(url.searchParams.get("path")).toBe(path);
    expect(url.searchParams.get("rootDir")).toBe(rootDir);
  });

  it.each([
    ["/private/tmp/申込%20画面.jpg", "/private/tmp/申込 画面.jpg"],
    ["file:///private/tmp/screen.jpg", "/private/tmp/screen.jpg"],
    ["images/a%2520b.jpg", "images/a%20b.jpg"],
    ["/private/tmp/100%.jpg", "/private/tmp/100%.jpg"],
    ["C:\\images\\screen.jpg", "C:/images/screen.jpg"],
  ])("decodes the parsed destination once: %s", (destination, path) => {
    const source = resolveRunnerMarkdownImage(destination, context)!;
    expect(new URL(source.uri).searchParams.get("path")).toBe(path);
    expect(source.headers).toEqual({ authorization: "Bearer token" });
    expect(new URL(source.uri).searchParams.has("token")).toBe(false);
  });

  it.each(["https://images.test/image.jpg?x=%20", "http://images.test/image.jpg", "data:image/png;base64,abc"]) (
    "preserves external sources without Runner headers: %s", (uri) => {
      expect(resolveRunnerMarkdownImage(uri, context)).toEqual({ uri });
    },
  );

  it("uses current Runner context when the destination is unchanged", () => {
    const first = resolveRunnerMarkdownImage("image.jpg", context)!;
    const second = resolveRunnerMarkdownImage("image.jpg", {
      runnerUrl: "http://other.test", runnerToken: "new-token", rootDir: "/other",
    })!;
    expect(second).not.toEqual(first);
    expect(new URL(second.uri).hostname).toBe("other.test");
    expect(new URL(second.uri).searchParams.get("rootDir")).toBe("/other");
    expect(second.headers).toEqual({ authorization: "Bearer new-token" });
  });

  it("leaves local files unresolved until credentials and Runner URL exist", () => {
    expect(resolveRunnerMarkdownImage("/private/tmp/image.jpg", { ...context, runnerToken: "" })).toBeNull();
    expect(resolveRunnerMarkdownImage("image.jpg", { ...context, runnerUrl: "" })).toBeNull();
    expect(getRunnerMediaSource("http://runner.test/files/media", " ")).toBeNull();
    expect(resolveRunnerMarkdownImage("https://images.test/a.jpg", { ...context, runnerToken: "" }))
      .toEqual({ uri: "https://images.test/a.jpg" });
  });
});
