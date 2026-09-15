import { createDesktopPlatform } from "./desktop.js";
import { createWebPlatform } from "./web.js";
import { createExtensionPlatform } from "./extension.js";

let webPlatform = null;
let desktopPlatform = null;
let extensionPlatform = null;

function activePlatform() {
  if (globalThis.chrome?.runtime?.id && globalThis.location?.protocol === "chrome-extension:") {
    extensionPlatform ||= createExtensionPlatform();
    return extensionPlatform;
  }
  if (globalThis.pywebview?.api) {
    desktopPlatform ||= createDesktopPlatform();
    return desktopPlatform;
  }
  webPlatform ||= createWebPlatform();
  return webPlatform;
}

export function createPlatform() {
  const platform = {
    get id() {
      return activePlatform().id;
    },
    get label() {
      return activePlatform().label;
    },
    startupOpen(...args) {
      return activePlatform().startupOpen(...args);
    },
    pickFile(...args) {
      return activePlatform().pickFile(...args);
    },
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pywebviewready", () => {
      document.body.dataset.platform = platform.id;
    });
  }
  return platform;
}
