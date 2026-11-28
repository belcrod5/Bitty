#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveControlSocket } from "../../skills/bitty-session-orchestrator/scripts/runner-control.mjs";
import { readBrowserControlNativeKey, NATIVE_CONTROL_DIRECTORY } from "../../private_runner/src/browser-control-native-auth.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const usage = "install-extension.mjs [--apply] [--home <directory>]";
async function directory(home, components, apply) {
  let current = home;
  for (const component of components) {
    current = path.join(current, component);
    const stat = await fs.lstat(current).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022)) throw new Error("unsafe_install_directory");
    if (!stat && apply) await fs.mkdir(current, { mode: 0o700 });
  }
  return current;
}
export async function installBrowserControlExtension({ repoRoot = source, home = os.homedir(), apply = false } = {}) {
  if (process.platform !== "darwin") throw new Error("macos_required");
  const homeStat = await fs.lstat(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== process.getuid() || homeStat.mode & 0o022) throw new Error("unsafe_install_home");
  const repo = await fs.realpath(repoRoot);
  const socketPath = await resolveControlSocket(repo);
  const manifest = JSON.parse(await fs.readFile(path.join(repo, "private_runner/browser-extension/manifest.json"), "utf8"));
  const extensionId = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
  const payloadComponents = NATIVE_CONTROL_DIRECTORY.split("/"), nativeComponents = ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"];
  const payloadRoot = await directory(home, payloadComponents, false);
  const extensionPath = await directory(home, [...payloadComponents, "extension"], false);
  const nativeDirectory = await directory(home, nativeComponents, false);
  await directory(home, [...payloadComponents, "node_modules", "ws", "lib"], false);
  const origin = `chrome-extension://${extensionId}/`;
  const keyPath = path.join(payloadRoot, "native-key"), config = { extensionOrigin: origin, socketPath, keyPath };
  const files = new Map([
    [path.join(extensionPath, "manifest.json"), await fs.readFile(path.join(repo, "private_runner/browser-extension/manifest.json"))],
    [path.join(extensionPath, "background.js"), await fs.readFile(path.join(repo, "private_runner/browser-extension/background.js"))],
    [path.join(payloadRoot, "host.mjs"), await fs.readFile(path.join(repo, "private_runner/src/browser-control-native-host.mjs"))],
    [path.join(payloadRoot, "browser-control-native-auth.mjs"), await fs.readFile(path.join(repo, "private_runner/src/browser-control-native-auth.mjs"))],
    [path.join(payloadRoot, "native-host.mjs"), `#!${process.execPath}\nimport { runBrowserControlNativeHost } from ${JSON.stringify(pathToFileURL(path.join(payloadRoot, "host.mjs")).href)};\nrunBrowserControlNativeHost(${JSON.stringify(config)}).catch(() => { process.stderr.write("bitty_browser_host_unavailable\\n"); process.exitCode = 1; });\n`],
    [path.join(nativeDirectory, "com.bitty.browser_control.json"), JSON.stringify({ name: "com.bitty.browser_control", description: "Private Bitty browser control", path: path.join(payloadRoot, "native-host.mjs"), type: "stdio", allowed_origins: [origin] }, null, 2) + "\n"],
  ]);
  const keyInfo = await fs.lstat(keyPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (keyInfo) await readBrowserControlNativeKey(keyPath);
  else files.set(keyPath, randomBytes(32).toString("base64url") + "\n");
  const wsRoot = path.dirname(createRequire(path.join(repo, "private_runner/package.json")).resolve("ws/package.json"));
  for (const name of ["package.json", "index.js", "LICENSE", ...(await fs.readdir(path.join(wsRoot, "lib"))).filter((name) => name.endsWith(".js")).map((name) => `lib/${name}`)]) {
    files.set(path.join(payloadRoot, "node_modules/ws", name), await fs.readFile(path.join(wsRoot, name)));
  }
  for (const [file, content] of files) {
    const stat = await fs.lstat(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (stat && (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o022)) throw new Error("unsafe_install_file");
  }
  if (apply) {
    await directory(home, [...payloadComponents, "extension"], true);
    await directory(home, nativeComponents, true);
    await directory(home, [...payloadComponents, "node_modules", "ws", "lib"], true);
    for (const [file, content] of files) {
      const mode = file.endsWith("native-host.mjs") ? 0o700 : 0o600;
      await fs.writeFile(file, content, { mode }); await fs.chmod(file, mode);
    }
  }
  return { mode: apply ? "apply" : "dry-run", extensionId, extensionPath, next: "Open chrome://extensions in the intended Chrome profile, enable Developer mode, and Load unpacked this extensionPath once." };
}
async function main() {
  let apply = false, home = os.homedir();
  const args = process.argv.slice(2);
  if (args[0] === "--help") { console.log(usage); return; }
  while (args.length) {
    const flag = args.shift();
    if (flag === "--apply" && !apply) apply = true;
    else if (flag === "--home" && args.length) home = path.resolve(args.shift());
    else throw new Error(usage);
  }
  console.log(JSON.stringify(await installBrowserControlExtension({ home, apply })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Browser extension setup unavailable. Use --help."); process.exitCode = 1; });
