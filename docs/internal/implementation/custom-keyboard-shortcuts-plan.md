# 自定义快捷键实施方案

> 日期：2026-09-27
> 工单：`Serpent-963e00`
> 范围：让用户改已有命令的快捷键。本文件是实施方案，不包含录制界面。

## 结论

可以做。命令表已经按平台分成 mac 与 Windows 两套按键，菜单和文档级 `keydown` 都从同一张表读。缺的是「用户覆盖」这一层，不是再做一套快捷键系统。

## 2026-09-27 对称性扫描

对照了命令注册表（资产、多选、侧栏、工具栏）、`platform-shortcut-table.ts`、主菜单 `shortcut(platform, mac, windows)`、选择与搜索聚焦、画布/查看器缩放、窗口全屏。

带快捷键的命令都同时有 mac 与 Windows 和弦。没有「只有 Windows、没有 mac」的条目。单测 `tests/unit/platform-shortcut-parity.test.ts` 锁住这一点。

平台原生差异（两边都有键，键本身不同）：

| 动作 | Windows | macOS |
| --- | --- | --- |
| 移入回收站 | Delete | ⌘⌫ |
| 从硬盘删除 | Shift+Delete | ⌥⌘Delete |
| 窗口全屏 | F11 | ⌃⌘F |
| 复制路径 | Ctrl+Shift+C | ⌥⌘C |

「在访达中打开」是 ⌘⇧S，与 Windows 的 Ctrl+Shift+S 成对。文件夹右键和标签页右键原先没画出这个键，现已画出。`SHORTCUT-FINDER-001` 已由用户验收通过。

视频 ±2 秒仍是两边都用 Ctrl+←/→。产品说明写明不用 ⌘，以免占用 macOS 系统键。见 `video-player-controls.ts`。

Windows 无边框窗口另有隐藏加速键（F2、Delete、Shift+Delete、视频 D/F/X/C、F11），因为系统菜单栏被藏起来后这些键到不了渲染进程。macOS 有系统菜单栏，同一批键由渲染进程和系统全屏角色接收，不另做一套隐藏菜单。

## 定义位置

- `src/renderer/commands/asset-commands.ts`
- `src/renderer/commands/asset-multi-commands.ts`
- `src/renderer/commands/sidebar-commands.ts`
- `src/renderer/commands/toolbar-commands.ts`
- `src/renderer/main-menu-items.ts`

mac 上「在访达中显示」没有系统级默认键可照搬。产品已选定 `⌘⇧S` 对齐 Windows 的 `Ctrl+Shift+S`，见人类验收清单 `FOLDER-REVEAL-001`。不要再加一个平行键。

## 目标行为

- 设置里能看到当前命令和当前按键。
- 用户录下新的按键后，菜单、右键和键盘处理立刻改用新按键。
- 恢复默认后回到命令表里的原键。
- mac 与 Windows 的覆盖分开保存。在一台机器上改 `⌘⇧S` 不会写成另一台机器的 `Ctrl+Shift+S`。
- 冲突时指出已经占用该键的命令，并让用户选择替换或取消。
- 输入框、对话框、查看器里正在输入时，浏览快捷键继续让路。这条规则不因自定义而放开。

## 数据

不要把快捷键写进资源库数据库。这是本机应用偏好，跟库无关。

建议放在现有本机偏好旁边，形状如下：

```ts
type ShortcutOverride = {
  commandId: string;
  platform: "mac" | "windows";
  chord: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  };
};
```

只存与默认不同的项。缺省即命令表原值。读入时丢掉未知 `commandId`、以及与当前平台不符的项。

`commandId` 用现有注册表的 id，例如 `folder.open-in-file-manager`。不要用菜单上的中文标题当键。

## 解析顺序

1. 取命令定义上的 `shortcut[platform]`。
2. 若本机覆盖里有同一 `commandId` + 当前平台，用覆盖。
3. `formatShortcut` 与 `matchesShortcut` 只看这一步的结果。

菜单、右键、`use-folder-command-shortcuts`、`use-browse-command-keyboard`、资产多选键盘都已经从注册表读 `shortcut`。改一处解析函数，这些入口一起变。不要在每个菜单里再写一份按键字符串。

Main 进程的隐藏加速键（Windows F2 / Delete、查看器逐帧）不在渲染进程的命令表里。自定义第一期不改这些加速键。若以后要改，Main 只能收到「命令 id → Electron accelerator 字符串」，不能收到任意脚本。

## 录制

复用设置页现有的表单和按钮，不新做一套浮层。

- 点某一行进入录制：下一组 `keydown` 写入草稿，不执行该命令。
- Esc 取消录制，不写入。输入法组合过程中的 Esc 不取消，沿用 `shouldHoldDismissForIme`。
- 只含修饰键的按键不接受。
- 与系统保留键冲突的组合要拒绝，并说明这个键留给系统。至少包括 mac 的 `⌘Q`、`⌘W`、`⌘Tab`、`⌘Space`，以及 Windows 的 `Alt+F4`、`Ctrl+Alt+Delete` 一类系统组合。清单写在一处常量里，不要散落在组件里。
- 与另一条 Serpent 命令冲突时，对话框列出对方命令名，选项是「改到这条」或「取消」。替换时清掉对方的覆盖，对方回到默认键；若默认键也撞车，继续提示，不要静默双绑。

## 分期

1. 解析层：覆盖表 + 单测。菜单文案和 `matchesShortcut` 都走解析结果。没有设置页。
2. 设置页：列表、录制、冲突、恢复默认。人类验收只覆盖这一期。
3. 可选：Windows Main 加速键跟随覆盖。没有这一期时，F2 / Delete 的隐藏菜单仍是默认键，设置页要写明这两条暂不能改。

## 不做

- 不给插件命令单独做一套存储。插件快捷键仍由插件声明；用户覆盖只针对内置 `commandId`。
- 不把查看器的 D/F、X/C 媒体键放进第一期。那些键的输入法规则在 `docs/internal/ui/0003-keyboard-shortcut-ux-principles.md`。
- 不在资源库之间同步快捷键。
- 不提供导入导出。

## 验收

- 单测：默认键、覆盖键、未知 id、跨平台条目被忽略、冲突替换后只剩一条绑定。
- 人类验收：完全退出再打开；把「在访达中打开」改成另一个未占用的键；菜单和按键都变成新键；恢复默认后回到 `⌘⇧S`；输入框聚焦时该键不触发命令。
- Windows 隐藏加速键在第三期之前保持默认，验收里写明未改。
