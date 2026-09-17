import { el } from "../utils/dom.js";

export class ToastHost {
  readonly root = el("div", { className: "toast-host", attrs: { "aria-live": "polite", "aria-atomic": "true" } });

  show(message: string, tone: "info" | "success" | "error" = "info", timeout = 4200): void {
    const toast = el("div", { className: `toast toast--${tone}`, text: message });
    this.root.append(toast);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    window.setTimeout(() => {
      toast.classList.remove("is-visible");
      window.setTimeout(() => toast.remove(), 220);
    }, timeout);
  }
}
