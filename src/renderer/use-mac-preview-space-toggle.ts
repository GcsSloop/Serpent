import { useLayoutEffect, useRef } from "react";

import { isTypingKeyboardTarget } from "./video-player-controls";

interface MacPreviewSpaceToggleOptions {
  enabled: boolean;
  previewOpen: boolean;
  canOpen: boolean;
  open: () => void;
  close: () => void | Promise<void>;
}

/** macOS Quick Look owns Space before any media-specific viewer shortcuts. */
export function useMacPreviewSpaceToggle(options: MacPreviewSpaceToggleOptions) {
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  // Register once during the shell's first layout, before viewer surfaces
  // register their passive capture listeners. Keep this listener in place
  // across asset navigation, media loading and transitions.
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = optionsRef.current;
      if (
        !current.enabled ||
        (event.key !== " " && event.code !== "Space") ||
        event.isComposing ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        isTypingKeyboardTarget(event.target)
      ) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"], select')) return;
      if (!current.previewOpen) {
        if (!current.canOpen) return;
        if (target?.closest('input, button:not(.asset-card), a, [role="button"]:not(.asset-card), [role="menuitem"]')) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // Swallow auto-repeat as well: holding the opener must not close the
      // viewer, or hand Space back to playback/default button activation.
      if (event.repeat) return;
      if (current.previewOpen) void current.close();
      else current.open();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
