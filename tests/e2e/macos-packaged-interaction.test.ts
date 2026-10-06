import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import sharp from "sharp";

import { assetCard, electronLaunchEnv } from "./electron-test-helpers";

test("packaged macOS app toggles previews and saves an inline filename edit", async () => {
  test.skip(process.platform !== "darwin", "macOS packaged interaction");
  const executablePath = process.env.SERPENT_E2E_PACKAGED_EXECUTABLE;
  if (!executablePath) throw new Error("Set SERPENT_E2E_PACKAGED_EXECUTABLE after packaging.");
  const root = mkdtempSync(path.join(tmpdir(), "serpent-packaged-interaction-"));
  const source = path.join(root, "hero.png");
  await sharp(Buffer.from('<svg width="480" height="320"><rect width="480" height="320" fill="#245bff"/><circle cx="240" cy="160" r="90" fill="#fff"/></svg>')).png().toFile(source);
  const rawFrames = path.join(root, "frames.rgb");
  const video = path.join(root, "clip.mp4");
  writeFileSync(rawFrames, Buffer.alloc(64 * 64 * 3 * 20, 100));
  execFileSync(path.resolve("resources/ffmpeg/darwin-arm64/ffmpeg"), [
    "-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "64x64", "-framerate", "10", "-i", rawFrames,
    "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", video,
  ], { stdio: "ignore" });
  const app = await electron.launch({
    executablePath, args: [],
    env: electronLaunchEnv({ SERPENT_E2E: "1", SERPENT_E2E_USER_DATA_PATH: path.join(root, "user-data") }),
  });
  try {
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string };
        const creating = options.title === "Create Library" || options.title === "创建资源库";
        return { canceled: false, filePaths: creating ? [paths.root] : [paths.source, paths.video] };
      };
    }, { root, source, video });
    const window = await app.firstWindow();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill("Mac Packaged");
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await window.getByRole("button", { name: "导入文件", exact: true }).first().click();
    const card = assetCard(window, "hero.png");
    await expect(card).toBeVisible();
    await expect(assetCard(window, "clip.mp4")).toBeVisible();
    const refresh = window.getByRole("button", { name: "刷新磁盘变化" });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await window.locator(".workspace-canvas").click({ position: { x: 8, y: 8 } });
    await expect(window.locator('.asset-card[aria-pressed="true"]')).toHaveCount(0);
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await expect(assetCard(window, "clip.mp4")).toHaveAttribute("aria-pressed", "false");
    await window.keyboard.press("Space");
    await expect(window.getByRole("region", { name: "hero.png 查看页面" })).toBeVisible();
    await window.keyboard.press("Space");
    await expect(window.locator(".workspace-viewer")).toHaveCount(0);
    await expect(card).toBeFocused();
    await card.locator(".asset-caption-filename").dblclick();
    const input = card.locator(".asset-inline-rename-input");
    await expect(input).toBeFocused();
    await input.fill("新版 名称.png");
    const inputBox = await input.boundingBox();
    const metadataBox = await card.locator(".asset-caption > span:last-child").boundingBox();
    expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(metadataBox!.y);
    await window.screenshot({ path: test.info().outputPath("inline-rename.png") });
    await window.getByRole("combobox", { name: "搜索资源库" }).click();
    const renamed = assetCard(window, "新版 名称.png");
    await expect(renamed).toBeVisible();
    expect(existsSync(path.join(root, "Mac Packaged", "Assets", "新版 名称.png"))).toBe(true);
    expect(existsSync(path.join(root, "Mac Packaged", "Assets", "hero.png"))).toBe(false);
    await renamed.locator(".asset-preview").dblclick();
    await expect(window.getByRole("region", { name: "新版 名称.png 查看页面" })).toBeVisible();
    await window.keyboard.press("Space");
    await expect(window.locator(".workspace-viewer")).toHaveCount(0);
    await assetCard(window, "clip.mp4").click();
    await window.keyboard.press("Space");
    const viewer = window.getByRole("region", { name: "clip.mp4 查看页面" });
    await expect(viewer.locator("video")).toBeVisible();
    await viewer.getByRole("slider", { name: "拖动视频进度" }).focus();
    await window.keyboard.press("Space");
    await expect(viewer).toBeHidden();

    // Keep the response pending briefly to verify visible save feedback and
    // consecutive edits through the real Inspector handlers/preload bridge.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      })._invokeHandlers;
      const handler = handlers.get("serpent:library:request")!;
      handlers.set("serpent:library:request", async (...args: unknown[]) => {
        const result = await handler(...args);
        if ((args[1] as { type?: string })?.type === "tag.assign.request") {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return result;
      });
    });
    await renamed.click();
    const addTag = window.locator(".inspector-tags-header button");
    await expect(addTag).toBeEnabled();
    for (const name of ["连续修改一", "连续修改二"]) {
      await addTag.click();
      await window.locator(".tag-add-input").fill(name);
      await window.keyboard.press("Enter");
      await expect(window.locator(".inspector-tag-saving")).toHaveText("正在保存标签…");
      await expect(addTag).toBeEnabled();
      await expect(window.locator(".inspector-tags-section .tag-chip-name").filter({ hasText: name })).toBeVisible();
      await expect(window.locator(".inspector-tag-saving")).toBeHidden();
    }
    await window.locator(".tag-chip").filter({ hasText: "连续修改一" }).getByRole("button", { name: "移除此标签" }).click();
    await expect(window.locator(".inspector-tags-section .tag-chip-name").filter({ hasText: "连续修改一" })).toHaveCount(0);
    await expect(window.locator(".inspector-tags-section .tag-chip-name").filter({ hasText: "连续修改二" })).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
