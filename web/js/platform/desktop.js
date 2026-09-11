export function createDesktopPlatform() {
  return {
    id: "desktop",
    label: "桌面版",
    async startupOpen() {
      try {
        const res = await fetch("/api/startup");
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.hasFile) return null;
        return { name: data.name, url: openedUrl(data.id), id: data.id };
      } catch {
        return null;
      }
    },
    async pickFile() {
      try {
        const result = await globalThis.pywebview.api.pick();
        if (result?.name) {
          return { name: result.name, url: openedUrl(result.id), id: result.id };
        }
      } catch {
        /* fall through */
      }
      return null;
    },
  };
}

function openedUrl(id) {
  return id ? `/opened/${encodeURIComponent(id)}.pdf` : `/opened.pdf?t=${Date.now()}`;
}
