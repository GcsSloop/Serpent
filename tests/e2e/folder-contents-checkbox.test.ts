import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assetCard, electronLaunchEnv, resolveElectronExecutablePath } from "./electron-test-helpers";

test.describe.configure({ timeout: 120_000 });

function folderRow(window: Page, name: string) {
  return window.locator(".navigation-pane .nav-row-label").filter({ hasText: new RegExp(`^${name}$`) })
    .locator("xpath=ancestor::button[contains(@class, 'nav-row')]");
}

async function finishFolderEdit(window: Page, name: string) {
  const input = window.locator(".nav-inline-edit input");
  await input.fill(name);
  // Enter can remove the row during dispatch; send it once to the focused input.
  await window.keyboard.press("Enter");
  await expect(window.locator(".nav-inline-edit")).toHaveCount(0);
  await expect(folderRow(window, name)).toBeVisible();
}

async function createChild(window: Page, parent: string, name: string) {
  await folderRow(window, parent).click({ button: "right" });
  await window.getByRole("menu", { name: `文件夹操作：${parent}`, exact: true })
    .getByRole("menuitem", { name: "新建子文件夹" }).click();
  await finishFolderEdit(window, name);
}

test("folder contents checkbox includes descendants, remembers each folder and survives restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "serpent-folder-contents-"));
  const name = "文件夹内容验收";
  const files = ["root.txt", "direct.txt", "child.txt", "grandchild.txt"].map((filename) => {
    const source = path.join(root, filename);
    writeFileSync(source, `Unique content for ${filename}`);
    return source;
  });
  const packaged = process.env.SERPENT_E2E_PACKAGED_EXECUTABLE;
  const directory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const launch = () => electron.launch({
    executablePath: packaged ?? resolveElectronExecutablePath(),
    args: packaged ? [] : [directory], cwd: directory,
    env: electronLaunchEnv({ SERPENT_E2E: "1", SERPENT_E2E_RESTORE_RECENT: "1", SERPENT_E2E_CREATE_PARENT_PATH: root, SERPENT_E2E_USER_DATA_PATH: path.join(root, "user-data") }),
  });
  let app = await launch();
  try {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, root);
    let window = await app.firstWindow();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(name);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    const importFile = async (index: number) => {
      const sourcePath = files[index]!;
      await app.evaluate(({ dialog }, source) => {
        process.env.SERPENT_E2E_IMPORT_FILES = source;
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      }, sourcePath);
      await window.getByRole("button", { name: "导入文件", exact: true }).first().click();
      await expect(assetCard(window, path.basename(sourcePath))).toBeVisible();
      const refresh = window.getByRole("button", { name: "刷新磁盘变化" });
      await expect(refresh).toBeEnabled();
      await refresh.click();
      await expect(refresh).toBeEnabled();
    };
    const libraryRoot = () => window.locator(".navigation-pane button.nav-row").filter({ hasText: "资源库根目录" });
    await libraryRoot().click();
    await importFile(0);
    await window.getByRole("button", { name: "添加文件夹" }).click();
    await finishFolderEdit(window, "父文件夹");
    await folderRow(window, "父文件夹").click();
    await importFile(1);
    await createChild(window, "父文件夹", "子文件夹");
    await folderRow(window, "子文件夹").click();
    await importFile(2);
    await createChild(window, "子文件夹", "孙文件夹");
    await folderRow(window, "孙文件夹").click();
    await importFile(3);
    expect(existsSync(path.join(root, name, "Assets", "父文件夹", "子文件夹", "孙文件夹", "grandchild.txt"))).toBe(true);

    await folderRow(window, "父文件夹").click();
    const checkbox = () => window.getByRole("checkbox", { name: "显示子文件夹内容" });
    await expect(checkbox()).not.toBeChecked();
    await expect(window.locator(".asset-card")).toHaveCount(1);
    await expect(assetCard(window, "direct.txt")).toBeVisible();
    await expect(window.getByRole("heading", { name: "子文件夹（1）", exact: true })).toBeVisible();
    await expect(window.getByRole("heading", { name: "内容（1）", exact: true })).toBeVisible();
    await checkbox().check();
    await expect(window.locator(".asset-card")).toHaveCount(3);
    await expect(assetCard(window, "child.txt")).toBeVisible();
    await expect(assetCard(window, "grandchild.txt")).toBeVisible();
    await expect(assetCard(window, "root.txt")).toHaveCount(0);
    await expect(window.getByRole("heading", { name: "内容（3）", exact: true })).toBeVisible();
    await expect(window.locator(".folder-card")).toHaveCount(1);
    const headerBox = await window.locator(".folder-browse-section-header").first().boundingBox();
    const folderBox = await window.locator(".folder-card-row").boundingBox();
    const canvasBox = await window.locator(".workspace-canvas").boundingBox();
    expect(headerBox!.width).toBeGreaterThan(canvasBox!.width - 40);
    expect(headerBox!.y).toBeLessThan(canvasBox!.y + 20);
    expect(folderBox!.y - (headerBox!.y + headerBox!.height)).toBeLessThan(20);
    // Close only test-generated notices so the screenshot exposes the new control.
    const noticeClose = window.locator(".workspace-notice-item:not(.is-closing) button[aria-label='关闭提示']");
    while (await noticeClose.count()) await noticeClose.first().click();
    await expect(window.locator(".workspace-notice-item")).toHaveCount(0);
    await window.screenshot({ path: test.info().outputPath("folder-contents.png") });

    // Space on a native checkbox toggles it even when an asset is selected.
    await assetCard(window, "direct.txt").click();
    await checkbox().focus();
    await window.keyboard.press("Space");
    await expect(checkbox()).not.toBeChecked();
    await expect(window.locator(".workspace-viewer")).toHaveCount(0);
    await expect(window.locator(".asset-card")).toHaveCount(1);
    await checkbox().check();
    await expect(window.locator(".asset-card")).toHaveCount(3);
    await folderRow(window, "子文件夹").click();
    await expect(checkbox()).not.toBeChecked();
    await expect(window.locator(".asset-card")).toHaveCount(1);
    await expect(assetCard(window, "child.txt")).toBeVisible();
    await folderRow(window, "父文件夹").click();
    await expect(checkbox()).toBeChecked();
    await expect(window.locator(".asset-card")).toHaveCount(3);

    await libraryRoot().click();
    await expect(checkbox()).not.toBeChecked();
    await expect(window.locator(".asset-card")).toHaveCount(1);
    await expect(assetCard(window, "root.txt")).toBeVisible();
    await checkbox().check();
    await expect(window.locator(".asset-card")).toHaveCount(4);
    await expect(window.getByRole("heading", { name: "内容（4）", exact: true })).toBeVisible();
    // Observe persisted state before restarting, rather than relying on a sleep.
    await expect.poll(() => window.evaluate(() => localStorage.getItem("serpent.folder-recursive.v1"))).toContain('"root":true');
    await app.close();
    app = await launch();
    window = await app.firstWindow();
    await expect(checkbox()).toBeVisible({ timeout: 20_000 });
    await expect(checkbox()).toBeChecked();
    await expect(window.locator(".asset-card")).toHaveCount(4);
    await checkbox().uncheck();
    await expect(window.locator(".asset-card")).toHaveCount(1);
    await folderRow(window, "父文件夹").click();
    await expect(checkbox()).toBeChecked();
    await expect(window.locator(".asset-card")).toHaveCount(3);
    await checkbox().uncheck();
    await expect(window.locator(".asset-card")).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
