import { fetchModelList, modelMatchesQuery } from "./translate-provider.js";

export function wireModelPicker({ input, menu, status, getCredentials }) {
  let models = [];
  let loadToken = 0;
  let activeController = null;

  const hideMenu = () => {
    menu.hidden = true;
  };

  const renderMenu = (query) => {
    menu.replaceChildren();
    const matches = models.filter((model) => modelMatchesQuery(model, query)).slice(0, 80);
    if (!matches.length) {
      hideMenu();
      return;
    }
    for (const model of matches) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      if (model.name && model.name !== model.id) {
        button.append(model.name, document.createElement("br"));
        const id = document.createElement("span");
        id.className = "model-id";
        id.textContent = model.id;
        button.append(id);
      } else {
        button.textContent = model.id;
      }
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        input.value = model.id;
        hideMenu();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      item.append(button);
      menu.append(item);
    }
    menu.hidden = false;
  };

  const setStatus = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle("error", isError);
    status.hidden = !text;
  };

  const refresh = async () => {
    const credentials = getCredentials();
    if (!credentials.apiKey?.trim() || !credentials.apiBaseUrl?.trim()) {
      models = [];
      hideMenu();
      setStatus("填写 API Key 与 Base URL 后可加载模型列表。");
      return;
    }
    const token = ++loadToken;
    activeController?.abort();
    activeController = new AbortController();
    setStatus("正在加载模型列表…");
    try {
      models = await fetchModelList(credentials, { signal: activeController.signal });
      if (token !== loadToken) return;
      setStatus(models.length ? `已加载 ${models.length} 个模型，输入可筛选。` : "没有返回可用模型。");
      renderMenu(input.value);
    } catch (error) {
      if (token !== loadToken || activeController.signal.aborted) return;
      models = [];
      hideMenu();
      setStatus(error.message || "无法加载模型列表。", true);
    }
  };

  input.addEventListener("focus", () => {
    if (models.length) renderMenu(input.value);
  });
  input.addEventListener("input", () => renderMenu(input.value));
  input.addEventListener("blur", () => {
    setTimeout(hideMenu, 120);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideMenu();
  });

  return { refresh, hideMenu };
}
