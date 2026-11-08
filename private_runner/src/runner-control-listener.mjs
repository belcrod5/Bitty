import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function startRunnerControlListener({ directory, socketPath, handler, installWebSocket }) {
  const root = await fs.realpath(directory);
  const socket = socketPath || path.join(root, "runner-control.sock");
  if (!path.isAbsolute(socket) || Buffer.byteLength(socket) >= (process.platform === "darwin" ? 104 : 108)) throw new Error("runner_control_socket_path_invalid");
  const parent = await fs.lstat(path.dirname(socket));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid()) throw new Error("runner_control_socket_permissions");
  try { await fs.lstat(socket); throw new Error("runner_control_socket_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const server = http.createServer(handler);
  const connections = new Set();
  server.on("connection", (connection) => {
    connections.add(connection); connection.once("close", () => connections.delete(connection));
  });
  installWebSocket(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { server.removeListener("error", reject); resolve(); }); });
  await fs.chmod(socket, 0o600);
  const identity = await fs.lstat(socket);
  return {
    server, socketPath: socket,
    async close() {
      const stopped = new Promise((resolve) => server.close(resolve));
      for (const connection of connections) connection.destroy();
      await stopped;
      const current = await fs.lstat(socket).catch(() => null);
      if (current?.ino === identity.ino && current?.dev === identity.dev) await fs.unlink(socket).catch((error) => { if (error.code !== "ENOENT") throw error; });
    },
  };
}
