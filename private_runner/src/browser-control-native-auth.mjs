import { promises as fs } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

export const NATIVE_CONTROL_DIRECTORY = "Library/Application Support/Bitty/BrowserControl";

// This key authorizes only the local native bridge, never ordinary Runner APIs.
export async function readBrowserControlNativeKey(file) {
  const directory = await fs.lstat(path.dirname(file)), info = await fs.lstat(file);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || directory.mode & 0o022
    || !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 128) throw new Error("browser_native_key_invalid");
  const value = (await fs.readFile(file, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("browser_native_key_invalid");
  return value;
}
export async function authenticateBrowserControlNativeKey(candidate, file) {
  const key = await readBrowserControlNativeKey(file);
  const supplied = Buffer.from(typeof candidate === "string" ? candidate : ""), expected = Buffer.from(key);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("browser_native_authentication_required");
}
