import { spawnSync } from "node:child_process";
import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIRECTORY = fileURLToPath(new URL("../logs/local-tls", import.meta.url));
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

function localHostName(env) {
  const configured = String(env.RUNNER_LOCAL_HOSTNAME || "").trim();
  if (configured) {
    const name = configured.replace(/\.local$/i, "");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(name)) {
      throw new Error("Invalid RUNNER_LOCAL_HOSTNAME");
    }
    return name + ".local";
  }
  if (process.platform !== "darwin") {
    throw new Error("Set RUNNER_LOCAL_HOSTNAME or RUNNER_LOCAL_URL for LAN HTTPS on this platform");
  }
  const result = spawnSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" });
  const name = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(name)) {
    throw new Error("Could not read a valid macOS LocalHostName");
  }
  return name.replace(/\.local$/i, "") + ".local";
}

function portNumber(raw) {
  const value = String(raw);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("Invalid local Runner TLS port");
  }
  return Number(value);
}

export function resolveLocalRunnerTlsConfig(env = process.env) {
  if (process.platform !== "darwin" && !String(env.RUNNER_LOCAL_URL || "").trim()
    && !String(env.RUNNER_LOCAL_HOSTNAME || "").trim()) return null;
  const httpPort = portNumber(env.PORT || env.RUNNER_PORT || 8788);
  const configured = String(env.RUNNER_LOCAL_URL || "").trim();
  let url;
  if (configured) {
    if (/[\u0000-\u0020]/.test(configured)) throw new Error("Invalid RUNNER_LOCAL_URL");
    url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("RUNNER_LOCAL_URL must be a local HTTPS origin");
    }
    // Old pairing settings advertised the plaintext listener. Migrate only the
    // hostname; the old HTTP port is never used for LAN traffic again.
    if (url.protocol === "http:") {
      url.protocol = "https:";
      url.port = String(portNumber(env.RUNNER_LOCAL_PORT || httpPort + 1));
    } else if (env.RUNNER_LOCAL_PORT && Number(url.port || 443) !== portNumber(env.RUNNER_LOCAL_PORT)) {
      throw new Error("RUNNER_LOCAL_PORT conflicts with RUNNER_LOCAL_URL");
    }
  } else {
    url = new URL(`https://${localHostName(env)}:${portNumber(env.RUNNER_LOCAL_PORT || httpPort + 1)}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const validDns = hostname.length <= 253 && hostname.split(".").every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!isIP(hostname) && !validDns) throw new Error("Invalid local Runner TLS hostname");
  const port = portNumber(url.port || 443);
  if (port === httpPort) throw new Error("LAN HTTPS and loopback HTTP require different ports");
  return {
    url: url.origin,
    hostname,
    port,
    directory: path.resolve(env.RUNNER_LOCAL_TLS_DIR || DEFAULT_DIRECTORY),
  };
}

function readCredentials(file) {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new Error("Runner TLS credentials must be private regular files owned by the Runner user");
  }
  chmodSync(file, 0o600);
  const value = JSON.parse(readFileSync(file, "utf8"));
  const certificate = new X509Certificate(value.cert);
  if (!certificate.checkPrivateKey(createPrivateKey(value.key))) {
    throw new Error("Runner TLS certificate and private key do not match");
  }
  return { ...value, certificate };
}

function saveCredentials(file, credentials, exclusive = false) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(credentials), { mode: 0o600, flag: "wx" });
    if (exclusive) {
      // Link an already complete file, so concurrent QR/startup never observes
      // a partial CA or silently replaces the paired trust anchor.
      try { linkSync(temporary, file); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } else {
      renameSync(temporary, file);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function generateCredentials(hostname, authority) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "bitty-local-tls-"));
  chmodSync(temporary, 0o700);
  try {
    const config = path.join(temporary, "openssl.cnf");
    const keyFile = path.join(temporary, "key.pem");
    const certFile = path.join(temporary, "cert.pem");
    const requestFile = path.join(temporary, "request.pem");
    const san = `${isIP(hostname) ? "IP" : "DNS"}:${hostname}`;
    writeFileSync(config, [
      "[req]", "prompt=no", "distinguished_name=dn", "[dn]",
      `CN=${authority ? "Bitty Runner LAN" : "Bitty Runner Local CA"}`,
      "[ca]", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "keyUsage=critical,keyCertSign,cRLSign", "subjectKeyIdentifier=hash",
      "[server]", "basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=serverAuth", `subjectAltName=${san}`, "authorityKeyIdentifier=keyid,issuer",
    ].join("\n"), { mode: 0o600 });
    const run = (args) => {
      const result = spawnSync("openssl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (result.status !== 0) throw new Error("OpenSSL could not generate Runner LAN TLS credentials");
    };
    const keyArgs = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-sha256"];
    if (!authority) {
      run(["req", "-new", "-x509", ...keyArgs, "-keyout", keyFile, "-out", certFile,
        "-days", "3650", "-config", config, "-extensions", "ca"]);
    } else {
      const caCert = path.join(temporary, "ca.pem");
      const caKey = path.join(temporary, "ca-key.pem");
      writeFileSync(caCert, authority.cert, { mode: 0o600 });
      writeFileSync(caKey, authority.key, { mode: 0o600 });
      run(["req", "-new", ...keyArgs, "-keyout", keyFile, "-out", requestFile, "-config", config]);
      run(["x509", "-req", "-in", requestFile, "-CA", caCert, "-CAkey", caKey,
        "-set_serial", `0x${randomBytes(16).toString("hex")}`, "-out", certFile, "-days", "365",
        "-sha256", "-extfile", config, "-extensions", "server"]);
    }
    chmodSync(keyFile, 0o600);
    chmodSync(certFile, 0o600);
    return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function loadLocalRunnerTls(config) {
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(config.directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0
    || directoryStat.uid !== process.getuid()) {
    throw new Error("Runner TLS directory must be private, owned by the Runner user, and not a symlink");
  }
  chmodSync(config.directory, 0o700);
  const authorityFile = path.join(config.directory, "authority.json");
  const serverFile = path.join(config.directory, "server.json");
  let authority = readCredentials(authorityFile);
  if (!authority) {
    // Losing the CA while a leaf remains must not silently reset pairing trust.
    if (existsSync(serverFile)) throw new Error("Runner LAN CA is missing; restore credentials or re-pair deliberately");
    saveCredentials(authorityFile, generateCredentials(config.hostname), true);
    authority = readCredentials(authorityFile);
  }
  const now = Date.now();
  if (!authority.certificate.ca || !authority.certificate.verify(authority.certificate.publicKey)
    || Date.parse(authority.certificate.validFrom) > now || Date.parse(authority.certificate.validTo) <= now) {
    throw new Error("Runner LAN CA is invalid or expired; restore credentials or re-pair deliberately");
  }
  let leaf = readCredentials(serverFile);
  if (leaf && (leaf.certificate.ca || !leaf.certificate.verify(authority.certificate.publicKey))) {
    throw new Error("Runner LAN certificate is not issued by the paired CA");
  }
  const matchesHost = leaf && (isIP(config.hostname)
    ? leaf.certificate.checkIP(config.hostname) : leaf.certificate.checkHost(config.hostname));
  if (!matchesHost || Date.parse(leaf.certificate.validTo) < now + RENEW_BEFORE_MS
    || Date.parse(leaf.certificate.validFrom) > now) {
    saveCredentials(serverFile, generateCredentials(config.hostname, authority));
    leaf = readCredentials(serverFile);
  }
  return {
    key: leaf.key,
    cert: leaf.cert,
    minVersion: "TLSv1.2",
    localRunnerCertificate: authority.certificate.raw.toString("base64"),
  };
}
