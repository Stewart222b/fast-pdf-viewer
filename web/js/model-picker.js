import { fetchModelList, isAllowedApiBaseUrl, modelMatchesQuery } from "./translate-provider.js";
import { t } from "./i18n.js";

const MODEL_LIST_TIMEOUT_MS = 15000;

export { isAllowedApiBaseUrl as isAllowedModelEndpoint } from "./translate-provider.js";

export function modelEndpointHost(value) {
  try {
    return new URL(String(value || "").trim()).hostname;
  } catch {
    return "";
  }
}

export function wireModelPicker({ input, menu, status, getCredentials }) {
  let models = [];
  let loadToken = 0;
  let activeController = null;
  let requestTimeout = null;
  let menuHideTimer = null;
  let activeIndex = -1;
  let suppressMenuOnInput = false;
  let modelListLoaded = false;

  const clearRequestTimeout = () => {
    if (requestTimeout !== null) clearTimeout(requestTimeout);
    requestTimeout = null;
  };

  const hideMenu = () => {
    if (menuHideTimer !== null) clearTimeout(menuHideTimer);
    menuHideTimer = null;
    menu.hidden = true;
    activeIndex = -1;
    input.setAttribute?.("aria-expanded", "false");
    input.removeAttribute?.("aria-activedescendant");
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

  const menuOptions = () => [...(menu.children || [])];

  const setActiveOption = (index) => {
    const options = menuOptions();
    activeIndex = options.length ? (index + options.length) % options.length : -1;
    options.forEach((option, optionIndex) => {
      option.classList?.toggle("active", optionIndex === activeIndex);
    });
    const activeOption = options[activeIndex];
    if (activeOption) {
      input.setAttribute?.("aria-activedescendant", activeOption.id);
      activeOption.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute?.("aria-activedescendant");
    }
  };

  const selectModel = (model) => {
    input.value = model.id;
    hideMenu();
    suppressMenuOnInput = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    suppressMenuOnInput = false;
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
    activeIndex = -1;
    for (const [index, model] of matches.entries()) {
      const item = document.createElement("li");
      item.id = `setting-model-option-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(model.id.toLowerCase() === input.value.trim().toLowerCase()));
      if (model.name && model.name !== model.id) {
        item.append(model.name, document.createElement("br"));
        const id = document.createElement("span");
        id.className = "model-id";
        id.textContent = model.id;
        item.append(id);
      } else {
        item.textContent = model.id;
      }
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("mousemove", () => setActiveOption(index));
      item.addEventListener("click", () => selectModel(model));
      menu.append(item);
    }
    menu.hidden = false;
    input.setAttribute?.("aria-expanded", "true");
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
    setStatus(t("missingCredentials", { fields: missing.join(t("and")) }));
  };

  const refresh = async () => {
    const credentials = getCredentials();
    if (!credentials.apiKey?.trim() || !credentials.apiBaseUrl?.trim()) {
      invalidatePending();
      setMissingCredentialsStatus(credentials);
      return;
    }
    if (!isAllowedApiBaseUrl(credentials.apiBaseUrl)) {
      invalidatePending();
      setStatus(t("modelEndpointMustUseHttps"), "warning");
      return;
    }
    const token = ++loadToken;
    clearRequestTimeout();
    activeController?.abort();
    activeController = new AbortController();
    const controller = activeController;
    let timedOut = false;
    models = [];
    modelListLoaded = false;
    hideMenu();
    setStatus(t("loadingModels"));
    const timeoutId = setTimeout(() => {
      if (token !== loadToken) return;
      timedOut = true;
      requestTimeout = null;
      controller.abort();
    }, MODEL_LIST_TIMEOUT_MS);
    requestTimeout = timeoutId;
    try {
      const loadedModels = await fetchModelList(credentials, { signal: controller.signal });
      if (token !== loadToken) return;
      models = loadedModels;
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
      if (token !== loadToken) return;
      models = [];
      modelListLoaded = false;
      hideMenu();
      if (timedOut) setStatus(t("modelListTimeout"), "error");
      else if (!controller.signal.aborted) setStatus(error.message || t("unableLoadModels"), "error");
    } finally {
      if (requestTimeout === timeoutId) clearRequestTimeout();
      if (activeController === controller) activeController = null;
    }
  };

  const invalidatePending = () => {
    loadToken += 1;
    clearRequestTimeout();
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

  const showPrompt = () => {
    invalidatePending();
    setStatus(t("modelCheckHint"));
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
    if (menuHideTimer !== null) clearTimeout(menuHideTimer);
    menuHideTimer = setTimeout(() => {
      menuHideTimer = null;
      hideMenu();
    }, 120);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideMenu();
      return;
    }
    const options = menuOptions();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (menu.hidden) renderMenu(input.value);
      const available = menuOptions();
      if (!menu.hidden && available.length) {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveOption(activeIndex < 0 ? (direction > 0 ? 0 : available.length - 1) : activeIndex + direction);
      }
      return;
    }
    if (event.key === "Enter" && !menu.hidden && options[activeIndex]) {
      event.preventDefault();
      const activeId = options[activeIndex].id;
      const modelIndex = Number(activeId.replace("setting-model-option-", ""));
      const model = models.filter((item) => modelMatchesQuery(item, input.value)).slice(0, 80)[modelIndex];
      if (model) selectModel(model);
    }
  });

  menu.closest?.(".modal-card")?.addEventListener("scroll", positionMenu, { passive: true });
  globalThis.addEventListener?.("resize", positionMenu);
  globalThis.addEventListener?.("scroll", positionMenu, true);

  return { refresh, hideMenu, invalidatePending, showPrompt };
}
