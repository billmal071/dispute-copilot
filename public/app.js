document.addEventListener("htmx:beforeSwap", (e) => {
  const status = e.detail.xhr.status;
  if (status >= 400 && status < 600) {
    e.detail.shouldSwap = true;
    e.detail.isError = false;
  }
});

const root = document.documentElement;
const prefersDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const currentTheme = () => root.dataset.theme || (prefersDark() ? "dark" : "light");

document.addEventListener("click", (e) => {
  const toggle = e.target.closest("#theme-toggle");
  if (!toggle) return;
  const next = currentTheme() === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem("dc-theme", next);
  } catch {}
});

const grow = (area) => {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight + 2}px`;
};
const growAll = (scope) => {
  for (const area of scope.querySelectorAll("textarea[data-autogrow]")) grow(area);
};

document.addEventListener("input", (e) => {
  const area = e.target.closest("textarea[data-autogrow]");
  if (!area) return;
  grow(area);
  const flag = area.closest(".note")?.querySelector(".edited");
  if (flag) flag.hidden = area.value === area.defaultValue;
});

document.addEventListener("htmx:afterSwap", (e) => growAll(e.target));
window.addEventListener("load", () => growAll(document));
document.addEventListener("DOMContentLoaded", () => growAll(document));

document.addEventListener("htmx:afterSwap", (e) => {
  if (e.target.id !== "draft-panel" && e.detail.target?.id !== "draft-panel") return;
  const slot = document.getElementById("modal-slot");
  const dialog = slot?.querySelector("dialog");
  if (dialog?.open) dialog.close();
  if (slot) slot.innerHTML = "";
  document.getElementById("draft-panel")?.scrollIntoView({ block: "nearest" });
});
