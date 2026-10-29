import { gzip } from "node:zlib";

export function json(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const vary = [...new Set([...String(headers.vary || "").split(",").map((value) => value.trim()).filter(Boolean), "Accept-Encoding"])].join(", ");
  const send = (data, compressed = false) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
      vary,
      "content-length": data.length,
      ...(compressed ? { "content-encoding": "gzip" } : {}),
    });
    res.end(res.req?.method === "HEAD" ? undefined : data);
  };
  const encodings = new Map(String(res.req?.headers?.["accept-encoding"] || "").split(",").map((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    return [name, quality === undefined ? 1 : Number(quality.trim().slice(2))];
  }));
  const gzipQuality = encodings.get("gzip") ?? encodings.get("*") ?? 0;
  if (body.length < 1024 || !(gzipQuality > 0 && gzipQuality <= 1)) {
    send(body);
    return;
  }
  // zlib runs off the event loop. Incompressible responses keep their original size.
  gzip(body, (error, compressed) => {
    if (error || compressed.length >= body.length) send(body);
    else send(compressed, true);
  });
}
