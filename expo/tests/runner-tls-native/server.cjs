const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");
const counts = { trusted: 0, rogue: 0, expired: 0, wrongName: 0, protocolSecrets: 0, metadataRange: 0, slowCancelled: 0, cloud: 0, redirected: 0, cloudAuthenticated: 0, cloudMissing: 0 };
const media = fs.readFileSync(process.argv[2]);
function create(prefix, name, certificate = `${prefix}server.pem`) {
  return https.createServer({ key: fs.readFileSync(`${prefix}server.key`), cert: fs.readFileSync(certificate) }, (req, res) => {
    counts[name] += 1;
    if (name === "cloud") {
      if (req.headers["cf-access-client-id"] !== "test-cloud-id" || req.headers["cf-access-client-secret"] !== "test-cloud-secret") {
        counts.cloudMissing += 1;
        res.writeHead(401); res.end(); return;
      }
      counts.cloudAuthenticated += 1;
    }
    if (req.headers.host.startsWith("127.0.0.1:")) counts.wrongName += 1;
    if (["/protocol", "/test.mp4"].includes(req.url) && req.headers["cf-access-client-secret"]) counts.protocolSecrets += 1;
    if (req.url === "/redirect" || req.url === "/cloud-redirect.mp4") {
      const target = req.url === "/redirect" ? rogue : redirected;
      res.writeHead(302, { Location: `https://localhost:${target.address().port}/steal` });
      res.end();
    } else if (req.url === "/slow.mp4") {
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-199999/200000",
        "Content-Length": 200000, "Accept-Ranges": "bytes" });
      res.write(Buffer.alloc(1024));
      const timer = setInterval(() => { res.write(Buffer.alloc(1024)); }, 100);
      res.on("close", () => { counts.slowCancelled += 1; clearInterval(timer); });
    } else if (["/test.mp4", "/malformed.mp4", "/cloud.mp4"].includes(req.url)) {
      const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
      if (match && start === 0 && end === 1) counts.metadataRange += 1;
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${req.url === "/malformed.mp4" ? start+1 : start}-${end}/${media.length}`,
        "Content-Length": end - start + 1, "Accept-Ranges": "bytes" });
      res.end(media.subarray(start, end + 1));
    } else { res.writeHead(200); res.end("ok"); }
  });
}
const rogue = create("rogue-", "rogue");
const trusted = create("", "trusted");
const expired = create("", "expired", "expired.pem");
const cloud = create("", "cloud");
const redirected = create("", "redirected");
trusted.on("upgrade", (request, socket, head) => {
  if (request.headers.authorization !== "Bearer temporary-native-test-only") { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const large = Buffer.alloc(2 * 1024 * 1024, "x");
  const largeHeader = Buffer.alloc(10);
  largeHeader[0] = 0x81;
  largeHeader[1] = 127;
  largeHeader.writeBigUInt64BE(BigInt(large.length), 2);
  socket.write(Buffer.concat([largeHeader, large]));
  let pending = head;
  socket.on("data", data => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 6) {
      const length = pending[1] & 127;
      if (length >= 126 || pending.length < 6 + length) return;
      const opcode = pending[0] & 15;
      const mask = pending.subarray(2, 6);
      const payload = Buffer.from(pending.subarray(6, 6 + length));
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      pending = pending.subarray(6 + length);
      socket.write(Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]));
      if (opcode === 8) socket.end();
    }
  });
  socket.on("error", () => {});
});
(async () => {
  for (const server of [rogue, trusted, expired, cloud, redirected]) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync("ports.json", JSON.stringify({ trusted: trusted.address().port, rogue: rogue.address().port, expired: expired.address().port, cloud: cloud.address().port, redirected: redirected.address().port }));
})();
process.on("SIGTERM", () => {
  fs.writeFileSync("counts.json", JSON.stringify(counts));
  for (const server of [trusted, rogue, expired, cloud, redirected]) server.close();
});
