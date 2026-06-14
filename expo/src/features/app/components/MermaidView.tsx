import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

const MERMAID_CDN_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

type MermaidViewProps = {
  chart: string;
  height?: number;
};

export function MermaidView({ chart, height = 260 }: MermaidViewProps) {
  const [measuredHeight, setMeasuredHeight] = useState(height);
  const html = useMemo(() => buildMermaidHtml(chart), [chart]);
  const resolvedHeight = Math.max(height, measuredHeight);

  useEffect(() => {
    setMeasuredHeight(height);
  }, [chart, height]);

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as { type?: string; height?: number };
      if (payload.type !== "height" || typeof payload.height !== "number") return;
      setMeasuredHeight(Math.max(160, Math.ceil(payload.height)));
    } catch {}
  };

  return (
    <View style={[mermaidStyles.wrap, { height: resolvedHeight }]}>
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        javaScriptEnabled
        onMessage={handleMessage}
        style={mermaidStyles.webView}
      />
    </View>
  );
}

function buildMermaidHtml(chart: string) {
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        margin: 0;
        padding: 12px;
        background: white;
      }
      .mermaid {
        display: flex;
        justify-content: center;
      }
      svg {
        max-width: 100%;
        height: auto;
      }
      .error {
        color: #b91c1c;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        white-space: pre-wrap;
      }
    </style>
    <script src="${MERMAID_CDN_URL}"></script>
  </head>
  <body>
    <pre class="mermaid">${escapeHtml(chart)}</pre>
    <script>
      mermaid.initialize({
        startOnLoad: true,
        securityLevel: "strict",
        theme: "default"
      });

      function postHeight() {
        var target = document.querySelector("svg") || document.body;
        var rect = target.getBoundingClientRect();
        var height = Math.ceil(rect.height + 24);
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
          type: "height",
          height: height
        }));
      }

      window.addEventListener("error", function (event) {
        document.body.innerHTML = '<pre class="error"></pre>';
        document.querySelector(".error").textContent = String(event.message || "Mermaid render failed");
        postHeight();
      });
      window.addEventListener("load", function () {
        setTimeout(postHeight, 160);
        setTimeout(postHeight, 700);
      });
    </script>
  </body>
</html>`;
}

const mermaidStyles = StyleSheet.create({
  wrap: {
    overflow: "hidden",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
  },
  webView: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
});
