// Apply before styles load, avoiding a light flash on dark startup.
(() => {
  const key = "fast-pdf-viewer-theme";
  let theme = "dark";

  function readStoredTheme() {
    try {
      return localStorage.getItem(key) === "light" ? "light" : "dark";
    } catch {
      return theme;
    }
  }

  const apply = () => {
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById("btn-theme");
    const isEnglish = document.documentElement.lang === "en";
    const label = isEnglish
      ? (theme === "dark" ? "Switch to light theme" : "Switch to dark theme")
      : (theme === "dark" ? "切换到浅色主题" : "切换到暗色主题");
    button?.setAttribute("aria-label", label);
    button?.setAttribute("title", label);
    document.getElementById("theme-icon")?.setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  };

  function setTheme(next) {
    theme = next === "light" ? "light" : "dark";
    apply();
    try { localStorage.setItem(key, theme); } catch { /* Keep the current session usable. */ }
  }

  theme = readStoredTheme();
  apply();

  globalThis.addEventListener?.("storage", (event) => {
    if (event.key !== key || event.storageArea !== localStorage) return;
    theme = event.newValue === "light" ? "light" : "dark";
    apply();
  });

  globalThis.addEventListener?.("fast-pdf-viewer-language-change", apply);

  document.addEventListener("DOMContentLoaded", () => {
    theme = readStoredTheme();
    apply();
    document.getElementById("btn-theme")?.addEventListener("click", () => {
      setTheme(theme === "dark" ? "light" : "dark");
    });
  });
})();
