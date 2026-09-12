import { fetchStartupOpen } from "./startup.js";

export function createWebPlatform() {
  return {
    id: "web",
    label: "网页版",
    startupOpen: fetchStartupOpen,
    async pickFile() {
      return null;
    },
  };
}
