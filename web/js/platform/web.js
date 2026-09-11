export function createWebPlatform() {
  return {
    id: "web",
    label: "网页版",
    async startupOpen() {
      return null;
    },
    async pickFile() {
      return null;
    },
  };
}
