import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

import {
  assetCard,
  electronLaunchEnv,
  importFilesThroughBridge,
  resolveElectronExecutablePath,
} from "./electron-test-helpers";

test.describe.configure({ timeout: 120_000 });
test.skip(process.platform !== "darwin", "macOS Quick Look interaction");

test("Space toggles image, video, audio and GIF previews and restores card focus", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "serpent-mac-space-"));
  const ffmpeg = path.resolve("resources/ffmpeg/darwin-arm64/ffmpeg");
  const sources = ["still.png", "clip.mp4", "sound.wav", "animated.gif"].map((name) => path.join(root, name));
  writeFileSync(sources[0]!, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64",
  ));
  // Release FFmpeg has no lavfi device; provide raw frames/audio instead.
  const rawFrames = path.join(root, "frames.rgb");
  writeFileSync(rawFrames, Buffer.alloc(64 * 64 * 3 * 20, 100));
  const videoInput = ["-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "64x64", "-framerate", "10", "-i", rawFrames];
  execFileSync(ffmpeg, [...videoInput, "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", sources[1]!], { stdio: "ignore" });
  const rawAudio = path.join(root, "sound.pcm");
  writeFileSync(rawAudio, Buffer.alloc(44100 * 2 * 2));
  execFileSync(ffmpeg, ["-y", "-f", "s16le", "-ar", "44100", "-ac", "1", "-i", rawAudio, sources[2]!], { stdio: "ignore" });
  execFileSync(ffmpeg, [...videoInput, sources[3]!], { stdio: "ignore" });
  const appDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [appDirectory], cwd: appDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: electronLaunchEnv({
      SERPENT_E2E: "1", SERPENT_E2E_CREATE_PARENT_PATH: root,
      SERPENT_E2E_USER_DATA_PATH: path.join(root, "user-data"),
      SERPENT_E2E_IMPORT_FILES: sources.join(path.delimiter),
    }),
  });
  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill("Mac Preview");
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await importFilesThroughBridge(window);
    for (const source of sources) {
      const name = path.basename(source);
      const card = assetCard(window, name);
      await card.click();
      await window.keyboard.press("Space");
      const viewer = window.getByRole("region", { name: `${name} 查看页面` });
      await expect(viewer).toBeVisible();
      // Repeat from a held opener cannot immediately close the new preview.
      await window.evaluate(() => globalThis.dispatchEvent(new KeyboardEvent("keydown", {
        key: " ", code: "Space", repeat: true, bubbles: true, cancelable: true,
      })));
      await expect(viewer).toBeVisible();
      if (name === "clip.mp4") {
        const scrubber = viewer.getByRole("slider", { name: "拖动视频进度" });
        await expect(scrubber).toBeVisible();
        await scrubber.focus();
      }
      await window.keyboard.press("Space");
      await expect(viewer).toBeHidden();
      await expect(card).toBeFocused();
      await expect(card).toHaveAttribute("aria-pressed", "true");
      // Double-click entry uses the same close shortcut.
      await card.locator(".asset-preview").dblclick();
      await expect(viewer).toBeVisible();
      await window.keyboard.press("Space");
      await expect(viewer).toBeHidden();
      await expect(card).toBeFocused();
    }
    const search = window.getByRole("combobox", { name: "搜索资源库" });
    await search.fill("still");
    await search.press("Space");
    await expect(search).toHaveValue("still ");
    await expect(window.locator(".workspace-viewer")).toHaveCount(0);
  } finally {
    await application.close();
    rmSync(root, { recursive: true, force: true });
  }
});
