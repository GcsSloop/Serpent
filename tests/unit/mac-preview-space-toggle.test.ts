// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useMacPreviewSpaceToggle } from "../../src/renderer/use-mac-preview-space-toggle";

it("owns Space before player capture handlers and keeps priority after navigation", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const open = vi.fn();
  const close = vi.fn();
  const player = vi.fn();
  function Shell({ previewOpen }: { previewOpen: boolean }) {
    useMacPreviewSpaceToggle({ enabled: true, previewOpen, canOpen: true, open, close });
    return createElement("button", { className: "asset-card" }, "Asset");
  }
  const press = (repeat = false) => container.firstElementChild!.dispatchEvent(
    new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true, repeat }),
  );
  try {
    await act(async () => root.render(createElement(Shell, { previewOpen: false })));
    window.addEventListener("keydown", player, true);
    expect(press()).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    for (let navigation = 0; navigation < 2; navigation++) {
      await act(async () => root.render(createElement(Shell, { previewOpen: true })));
      press(true);
      expect(close).toHaveBeenCalledTimes(navigation);
      press();
      expect(close).toHaveBeenCalledTimes(navigation + 1);
    }
    expect(player).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", player, true);
    await act(async () => root.unmount());
    container.remove();
  }
});

it("preserves typing, composition, modified shortcuts and modal controls", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  function Shell({ enabled }: { enabled: boolean }) {
    useMacPreviewSpaceToggle({ enabled, previewOpen: true, canOpen: true, open: vi.fn(), close });
    return createElement("div", null,
      createElement("input"),
      createElement("textarea"),
      createElement("div", { contentEditable: true }),
      createElement("div", { role: "dialog" }, createElement("button")),
      createElement("input", { type: "range" }),
    );
  }
  const space = (extra: KeyboardEventInit = {}) => new KeyboardEvent("keydown", {
    key: " ", code: "Space", bubbles: true, cancelable: true, ...extra,
  });
  try {
    await act(async () => root.render(createElement(Shell, { enabled: true })));
    for (const target of container.querySelectorAll('input:not([type="range"]), textarea, [contenteditable], button')) {
      expect(target.dispatchEvent(space())).toBe(true);
    }
    for (const extra of [{ isComposing: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect(container.dispatchEvent(space(extra))).toBe(true);
    }
    expect(close).not.toHaveBeenCalled();
    expect(container.querySelector('input[type="range"]')!.dispatchEvent(space())).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement(Shell, { enabled: false })));
    expect(container.dispatchEvent(space())).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
