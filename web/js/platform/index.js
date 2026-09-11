import { createDesktopPlatform } from "./desktop.js";
import { createWebPlatform } from "./web.js";

export function createPlatform() {
  if (globalThis.pywebview?.api) return createDesktopPlatform();
  return createWebPlatform();
}
