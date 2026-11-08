import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

// Local control credentials never cross a TCP listener, including loopback.
export async function resolveControlSocket(repoRoot, configured = process.env.RUNNER_CONTROL_SOCKET) {
  let socketPath;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("RUNNER_CONTROL_SOCKET must be an absolute path");
    socketPath = path.join(await fs.realpath(path.dirname(configured)), path.basename(configured));
  } else {
    if (!repoRoot) throw new Error("Set BITTY_REPO_ROOT or RUNNER_CONTROL_SOCKET for local Runner control");
    socketPath = path.join(await fs.realpath(path.join(repoRoot, "private_runner/logs")), "runner-control.sock");
  }
  const limit = process.platform === "darwin" ? 103 : 107;
  if (Buffer.byteLength(socketPath) > limit) throw new Error("RUNNER_CONTROL_SOCKET exceeds the OS path limit");
  return socketPath;
}

export function requestControl(socketPath, pathname, { method = "GET", headers = {}, body, timeout = 30_000 } = {}) {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\r\n]/.test(pathname)) {
    throw new Error("Runner control request requires a local path");
  }
  return new Promise((resolve, reject) => {
    let timer;
    const fail = error => { clearTimeout(timer); reject(error); };
    const request = http.request({ socketPath, path: pathname, method,
      headers: { ...headers, ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}) } }, response => {
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) request.destroy(new Error("Runner response exceeds size limit"));
        else chunks.push(chunk);
      });
      response.on("error", () => fail(Object.assign(new Error("Runner response could not be read"), { code: "runner_response_incomplete" })));
      response.on("end", () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
          text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    timer = setTimeout(() => request.destroy(new Error("Runner control request timed out")), timeout);
    request.on("error", fail);
    request.end(body);
  });
}
