import { fetchModelList, modelMatchesQuery } from "./translate-provider.js";
import { t } from "./i18n.js";

export function wireModelPicker({ input, menu, status, getCredentials }) {
  let models = [];
  let loadToken = 0;
  let activeController = null;
  let suppressMenuOnInput = false;
  let modelListLoaded = false;

  const hideMenu = () => {
    menu.hidden = true;
  };

  const isModelFieldFocused = () => document.activeElement === input;

  const positionMenu = () => {
    if (menu.hidden) return;
    const anchor = menu.parentElement?.getBoundingClientRect?.();
    const style = menu.style;
    if (!anchor || !style || !menu.getBoundingClientRect) return;

    const gap = 4;
    const viewportHeight = globalThis.innerHeight || document.documentElement?.clientHeight || 0;
    style.left = `${Math.round(anchor.left)}px`;
    style.top = `${Math.round(anchor.bottom + gap)}px`;
    style.width = `${Math.round(anchor.width)}px`;

    const menuHeight = menu.getBoundingClientRect().height;
    const spaceBelow = viewportHeight - anchor.bottom - gap;
    const spaceAbove = anchor.top - gap;
    if (menuHeight > spaceBelow && menuHeight <= spaceAbove) {
      style.top = `${Math.round(anchor.top - menuHeight - gap)}px`;
    }
  };

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
    positionMenu();
  };

  const setStatus = (text, state = "neutral") => {
    const normalizedState = state === true ? "error" : state;
    const message = String(text || "");
    status.textContent = normalizedState === "error" && !message.startsWith("✕")
      ? t("modelLoadFailed", { message })
      : message;
    status.classList.toggle("error", normalizedState === "error");
    status.classList.toggle("success", normalizedState === "success");
    status.classList.toggle("warning", normalizedState === "warning");
    status.hidden = !message;
  };

  const updateModelStatus = () => {
    if (!modelListLoaded) return;
    const currentModel = String(getCredentials().model ?? input.value ?? "").trim();
    if (!models.length) {
      setStatus(t("modelListEmptyWarning"), "warning");
      return;
    }
    if (!currentModel) {
      setStatus(t("modelIdRequired"), "warning");
      return;
    }
    const found = models.some((model) => model.id.toLowerCase() === currentModel.toLowerCase());
    if (found) {
      setStatus(t("modelFound", { model: currentModel, count: models.length }), "success");
    } else {
      setStatus(t("modelNotFound"), "warning");
    }
  };

  const setMissingCredentialsStatus = (credentials) => {
    const missing = [];
    if (!credentials.apiKey?.trim()) missing.push("API Key");
    if (!credentials.apiBaseUrl?.trim()) missing.push("Base URL");
    setStatus(t("missingCredentials", { fields: missing.join(t("and")) }), "error");
  };

  const refresh = async () => {
    const credentials = getCredentials();
    if (!credentials.apiKey?.trim() || !credentials.apiBaseUrl?.trim()) {
      loadToken += 1;
      activeController?.abort();
      activeController = null;
      models = [];
      modelListLoaded = false;
      hideMenu();
      setMissingCredentialsStatus(credentials);
      return;
    }
    const token = ++loadToken;
    activeController?.abort();
    activeController = new AbortController();
    models = [];
    modelListLoaded = false;
    hideMenu();
    setStatus(t("loadingModels"));
    try {
      models = await fetchModelList(credentials, { signal: activeController.signal });
      if (token !== loadToken) return;
      modelListLoaded = true;
      const latest = getCredentials();
      if (!latest.apiKey?.trim() || !latest.apiBaseUrl?.trim()) {
        models = [];
        modelListLoaded = false;
        hideMenu();
        setMissingCredentialsStatus(latest);
        return;
      }
      setStatus(models.length ? t("modelsLoaded", { count: models.length }) : t("noModels"));
      updateModelStatus();
      renderMenu(input.value);
    } catch (error) {
      if (token !== loadToken || activeController.signal.aborted) return;
      models = [];
      modelListLoaded = false;
      hideMenu();
      setStatus(error.message || t("unableLoadModels"), true);
    }
  };

  const invalidatePending = () => {
    loadToken += 1;
    activeController?.abort();
    activeController = null;
    models = [];
    modelListLoaded = false;
    hideMenu();
    const credentials = getCredentials();
    if (credentials.apiKey?.trim() && credentials.apiBaseUrl?.trim()) {
      setStatus(t("configChanged"));
    } else {
      setMissingCredentialsStatus(credentials);
    }
  };

  input.addEventListener("focus", () => {
    if (models.length) renderMenu(input.value);
  });
  input.addEventListener("input", () => {
    updateModelStatus();
    if (suppressMenuOnInput) return;
    renderMenu(input.value);
  });
  input.addEventListener("blur", () => {
    setTimeout(hideMenu, 120);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideMenu();
  });

  menu.closest?.(".modal-card")?.addEventListener("scroll", positionMenu, { passive: true });
  globalThis.addEventListener?.("resize", positionMenu);
  globalThis.addEventListener?.("scroll", positionMenu, true);

  return { refresh, hideMenu, invalidatePending };
}
