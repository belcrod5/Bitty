import { buildRunnerFileViewerHtml } from "./RunnerFileViewer";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-webview", () => ({ WebView: () => null }));

test("keeps HTML file content unchanged", () => {
  const content = "<!doctype html><html><body>Hello</body></html>";
  expect(buildRunnerFileViewerHtml("html", content)).toBe(content);
});

test("sends drawio XML safely to the official chromeless viewer", () => {
  const xml = `<mxfile><diagram name='A &quot;B&quot; & C'><mxCell value="</script><img src=x onerror=alert(1)>"></mxCell></diagram></mxfile>`;
  const html = buildRunnerFileViewerHtml("drawio", xml);

  expect(html).toContain("https://viewer.diagrams.net/?lightbox=1&amp;chrome=0");
  expect(html).toContain("create=%7B%22type%22%3A%22message%22%7D");
  expect(html).toContain("maximum-scale=1.0, user-scalable=no");
  expect(html).toContain('event.origin !== "https://viewer.diagrams.net"');
  expect(html).toContain('action: "create"');
  expect(html).toContain('type: "xml"');
  expect(html.indexOf('window.addEventListener("message"')).toBeLessThan(
    html.indexOf('.src = "https://viewer.diagrams.net/')
  );
  expect(html).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain("&#39;A &amp;quot;B&amp;quot; &amp; C&#39;");
  expect(html).not.toContain("</script><img");
  expect(html).not.toContain(xml);
  expect(html).not.toContain("GraphViewer");
  expect(html).not.toContain("pinchEnabled");
});
