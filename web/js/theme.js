// Apply before styles load, avoiding a light flash on dark startup.
(() => {
  const key = "fast-pdf-viewer-theme";
  let theme = "dark";
  try {
    if (localStorage.getItem(key) === "light") theme = "light";
  } catch { /* Storage may be unavailable; the switch still works. */ }
  const apply = () => {
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById("btn-theme");
    const label = theme === "dark" ? "切换到浅色主题" : "切换到暗色主题";
    button?.setAttribute("aria-label", label);
    button?.setAttribute("title", label);
    document.getElementById("theme-icon")?.setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  };
  apply();
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("btn-theme")?.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      apply();
      try { localStorage.setItem(key, theme); } catch { /* Keep the current session usable. */ }
    });
  });
})();
