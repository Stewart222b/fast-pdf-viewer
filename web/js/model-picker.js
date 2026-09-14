import { fetchModelList, modelMatchesQuery } from "./translate-provider.js";

export function wireModelPicker({ input, menu, status, getCredentials }) {
  let models = [];
  let loadToken = 0;
  let activeController = null;
  let suppressMenuOnInput = false;

  const hideMenu = () => {
    menu.hidden = true;
  };

  const isModelFieldFocused = () => document.activeElement === input;

  const renderMenu = (query) => {
    menu.replaceChildren();
    const matches = models.filter((model) => modelMatchesQuery(model, query)).slice(0, 80);
    // Only open under the model field. Opening Settings focuses API Key and
    // refresh() must not dump the list over that input.
    if (!matches.length || !isModelFieldFocused()) {
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
        suppressMenuOnInput = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        suppressMenuOnInput = false;
        input.blur();
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
      loadToken += 1;
      activeController?.abort();
      activeController = null;
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
      const latest = getCredentials();
      if (!latest.apiKey?.trim() || !latest.apiBaseUrl?.trim()) {
        models = [];
        hideMenu();
        setStatus("填写 API Key 与 Base URL 后可加载模型列表。");
        return;
      }
      setStatus(models.length ? `已加载 ${models.length} 个模型，输入可筛选。` : "没有返回可用模型。");
      renderMenu(input.value);
    } catch (error) {
      if (token !== loadToken || activeController.signal.aborted) return;
      models = [];
      hideMenu();
      setStatus(error.message || "无法加载模型列表。", true);
    }
  };

  const invalidatePending = () => {
    loadToken += 1;
    activeController?.abort();
    activeController = null;
  };

  input.addEventListener("focus", () => {
    if (models.length) renderMenu(input.value);
  });
  input.addEventListener("input", () => {
    if (suppressMenuOnInput) return;
    renderMenu(input.value);
  });
  input.addEventListener("blur", () => {
    setTimeout(hideMenu, 120);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideMenu();
  });

  return { refresh, hideMenu, invalidatePending };
}
