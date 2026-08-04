import { buildRunnerFileViewerHtml } from "./RunnerFileViewer";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-webview", () => ({ WebView: () => null }));

test("keeps HTML file content unchanged", () => {
  const content = "<!doctype html><html><body>Hello</body></html>";
  expect(buildRunnerFileViewerHtml("html", content)).toBe(content);
});

test("renders drawio XML safely with the official static viewer", () => {
  const xml = `<mxfile><diagram name='A &quot;B&quot; & C'><mxCell value="</script><img src=x onerror=alert(1)>"></mxCell></diagram></mxfile>`;
  const html = buildRunnerFileViewerHtml("drawio", xml);

  expect(html).toContain("https://viewer.diagrams.net/js/viewer-static.min.js");
  expect(html).toContain("maximum-scale=8.0, user-scalable=yes");
  expect(html).toContain('class="mxgraph"');
  expect(html).toContain('class="drawio-native-scroll"');
  expect(html).toContain('&quot;toolbar&quot;:&quot;pages layers&quot;');
  expect(html).toContain('&quot;toolbar-nohide&quot;:true');
  expect(html).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain("&#39;A &amp;quot;B&amp;quot; &amp; C&#39;");
  expect(html).not.toContain("</script><img");
  expect(html).not.toContain(xml);
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("postMessage");
  expect(html).not.toContain("pinchEnabled");
});
