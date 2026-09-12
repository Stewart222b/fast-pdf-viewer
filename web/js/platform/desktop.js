import { fetchStartupOpen, openedUrl } from "./startup.js";

export function createDesktopPlatform() {
  return {
    id: "desktop",
    label: "桌面版",
    startupOpen: fetchStartupOpen,
    async pickFile() {
      try {
        const result = await globalThis.pywebview.api.pick();
        if (result?.name) {
          return {
            name: result.name,
            path: result.path,
            url: openedUrl(result.id),
            id: result.id,
          };
        }
      } catch {
        /* fall through */
      }
      return null;
    },
  };
}
