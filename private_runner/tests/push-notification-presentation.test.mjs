import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PUSH_NOTIFICATION_CATEGORIES, pushNotificationPresentation } from "../src/push-notification-presentation.mjs";

test("every remote purpose has a bundled iOS image and a valid custom notification sound", () => {
  const app = JSON.parse(fs.readFileSync(new URL("../../expo/app.json", import.meta.url))).expo;
  const soundPaths = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-notifications")[1].sounds;
  const sounds = new Set();
  for (const category of PUSH_NOTIFICATION_CATEGORIES) {
    const presentation = pushNotificationPresentation(category);
    assert.equal(presentation.category, category);
    assert.equal(presentation["mutable-content"], 1);
    sounds.add(presentation.sound);
    assert.ok(soundPaths.includes(`./notifications/assets/sounds/${presentation.sound}`));
    const audio = fs.readFileSync(new URL(`../../expo/notifications/assets/sounds/${presentation.sound}`, import.meta.url));
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.toString("ascii", 8, 12), "WAVE");
    assert.equal(audio.readUInt16LE(20), 1, "notification sound is linear PCM");
    assert.equal(audio.readUInt16LE(34), 16);
    assert.ok(audio.length / audio.readUInt32LE(28) < 30, "notification sound is shorter than 30 seconds");
    const imageName = category.toLowerCase().replaceAll("_", "-");
    const png = fs.readFileSync(new URL(`../../expo/notifications/assets/icons/${imageName}.png`, import.meta.url));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.equal(sounds.size, PUSH_NOTIFICATION_CATEGORIES.length, "each purpose has a distinct sound");
});

test("the independent native extension recognizes exactly the runner's remote purposes", () => {
  const swift = fs.readFileSync(new URL("../../expo/notifications/BittyNotificationService/NotificationService.swift", import.meta.url), "utf8");
  const nativeCategories = [...swift.matchAll(/"([A-Z]+_[A-Z_]+)"/g)].map(([, category]) => category);
  assert.deepEqual(new Set(nativeCategories), new Set(PUSH_NOTIFICATION_CATEGORIES));
});

test("unknown purposes keep standard presentation without invoking the extension", () => {
  assert.deepEqual(pushNotificationPresentation("FUTURE_PURPOSE"), { category: "FUTURE_PURPOSE", sound: "default" });
});
