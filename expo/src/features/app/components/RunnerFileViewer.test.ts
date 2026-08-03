import { buildRunnerFileViewerHtml } from "./RunnerFileViewer";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-webview", () => ({ WebView: () => null }));

test("keeps HTML file content unchanged", () => {
  const content = "<!doctype html><html><body>Hello</body></html>";
  expect(buildRunnerFileViewerHtml("html", content)).toBe(content);
});

test("embeds drawio XML safely and loads the official viewer", () => {
  const xml = `<mxfile><diagram name='A &quot;B&quot; & C'><mxCell value="</script><img src=x onerror=alert(1)>"></mxCell></diagram></mxfile>`;
  const html = buildRunnerFileViewerHtml("drawio", xml);

  expect(html).toContain("https://viewer.diagrams.net/js/viewer-static.min.js");
  expect(html).toContain('id="drawio-viewer"');
  expect(html).not.toContain('class="mxgraph"');
  expect(html).toContain("GraphViewer.createViewerForElement");
  expect(html).toContain("viewer.graph.panningHandler.setPinchEnabled(true)");
  expect(html).toContain('&quot;toolbar&quot;:&quot;zoom layers lightbox&quot;');
  expect(html).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain("&#39;A &amp;quot;B&amp;quot; &amp; C&#39;");
  expect(html).not.toContain("</script><img");
  expect(html).not.toContain(xml);
});
