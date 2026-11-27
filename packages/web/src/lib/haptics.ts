let iosSwitch: HTMLLabelElement | null = null;

function isAppleTouch(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * A short tap of the haptic engine. Android has `navigator.vibrate`; iOS Safari (18+) has none,
 * but toggling a native switch control plays its haptic, so we click a hidden one.
 */
export function haptic(kind: "light" | "medium" = "light"): void {
  try {
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(kind === "light" ? 8 : 15);
      return;
    }
    if (!isAppleTouch()) return;
    if (!iosSwitch) {
      const label = document.createElement("label");
      label.setAttribute("aria-hidden", "true");
      label.style.cssText =
        "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:0";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.tabIndex = -1;
      label.appendChild(input);
      document.body.appendChild(label);
      iosSwitch = label;
    }
    iosSwitch.click();
  } catch {
    // Haptics are optional.
  }
}
