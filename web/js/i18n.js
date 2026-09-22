const SUPPORTED_LOCALES = new Set(["zh-CN", "en"]);

const messages = {
  "zh-CN": {
    modelIncompleteTranslation: "翻译未完成（{reason}），请重试。",
    fileNavigation: "文件与导航", open: "打开", openPdf: "打开 PDF", originalPdf: "原始 PDF",
    openOriginalPdf: "用浏览器打开原始 PDF", toggleSidebar: "显示/隐藏目录侧栏",
    back: "返回", backHint: "返回（鼠标侧键 / Alt+← / Backspace）", forward: "前进",
    forwardHint: "前进（鼠标侧键 / Alt+→）", pageNumber: "页码", pageJump: "输入页码后回车跳转",
    currentPage: "当前页码", noFile: "未打开文件", zoom: "缩放", zoomOut: "缩小", zoomIn: "放大",
    fitWidth: "适合宽度", fitPage: "适合页面", search: "搜索", more: "更多", settings: "设置",
    switchLight: "切换到浅色主题", switchDark: "切换到暗色主题", sidebarMode: "侧栏模式",
    outline: "目录", expandAll: "全部展开", collapseAll: "全部折叠", closeSidebar: "关闭侧栏",
    documentOutline: "文档目录", searchDocument: "搜索文档", clearSearch: "清除搜索",
    previous: "上一个", next: "下一个", previousHint: "上一个 (Shift+Enter)", nextHint: "下一个 (Enter)", closeHint: "关闭 (Esc)", resizeSidebar: "调整侧栏宽度", chooseAgain: "重新选择文件",
    openPdfFile: "打开 PDF 文件", dropToRead: "将文件拖到这里开始阅读", chooseFile: "选择文件…",
    translateSelection: "翻译选中文本", translateChip: "译", dragTranslation: "拖动翻译窗，也可使用方向键移动",
    dragTranslationHint: "按住拖动翻译窗", pinTranslation: "固定翻译窗", unpinTranslation: "取消固定翻译窗",
    close: "关闭", expandSource: "展开原文", collapseSource: "收起原文", currentModel: "当前翻译模型",
    copyResult: "复制翻译结果", copied: "已复制", copyFailed: "复制失败", passwordRequired: "需要 PDF 密码",
    encryptedHint: "此文档已加密，请输入打开密码。", password: "密码", cancel: "取消", save: "保存",
    translationSettings: "翻译设置", model: "模型", targetLanguage: "目标语言", interfaceLanguage: "界面语言",
    chineseSimplified: "简体中文", english: "English", autoTranslate: "划词后自动翻译",
    servicePrivacy: "服务地址与隐私", localPrivacy: "Base URL 与 Key 只保存在本机浏览器中；翻译直接从本机发往你配置的端点。",
    apiBase: "API Base URL（OpenAI 兼容）", extensionSettings: "扩展设置", passwordCancelled: "已取消输入密码",
    passwordIncorrect: "密码错误，请重试。", opening: "正在打开…", openFailed: "打开失败：{message}",
    noOutline: "这份 PDF 没有目录。", unnamed: "未命名", toggleBranch: "展开/折叠", pageDescription: "第 {page} 页",
    searchPrompt: "输入关键词后，这里会列出全部命中。", zeroResults: "0 条", noMatches: "没有找到匹配。",
    previousResults: "上一组结果", nextResults: "下一组结果", pageMeta: "第 {page} 页 · {current}/{total}",
    locateFailed: "定位失败：{message}", partialIndex: "部分页面索引失败，当前仅显示已读取结果。",
    indexing: "索引 {current}/{total}", searchFailed: "搜索失败：{message}", setupTranslation: "设置翻译",
    retry: "重试", textTooLong: "选中文本过长（{count} 字），请缩短到 {max} 字以内。",
    nothingToCopy: "没有可复制的内容", copySuccessAnnouncement: "翻译结果已复制到剪贴板",
    copyFailureAnnouncement: "复制失败，请检查浏览器剪贴板权限", permissionDenied: "未获得服务地址访问权限，设置尚未保存。",
    saveFailed: "保存失败，请重试。", openOriginalFailed: "无法打开原始 PDF。", openDocumentFailed: "无法打开文档。",
    modelLoadFailed: "✕ 模型列表加载失败：{message}", modelListEmptyWarning: "⚠ 模型列表请求成功，但服务商未返回模型，暂时无法确认当前模型。",
    modelIdRequired: "⚠ 请填写模型 ID；列表无法确认空模型。", modelFound: "✓ 已在模型列表中找到 {model}（共 {count} 个模型）",
    modelNotFound: "⚠ 列表中未找到当前模型；服务商可能未返回完整列表，自定义模型 ID 仍可使用。",
    missingCredentials: "✕ 请填写 {fields} 后再检查模型列表。", and: " 和 ", loadingModels: "正在加载模型列表…",
    modelsLoaded: "已加载 {count} 个模型，输入可筛选。", noModels: "没有返回可用模型。", unableLoadModels: "无法加载模型列表。",
    modelListRequestFailed: "无法加载模型列表 ({status})",
    configChanged: "配置已更改，等待重新检查模型列表…", modelNoTranslation: "模型没有返回译文。",
    apiKeyRequired: "还没有填写 API Key，请先打开设置。", noText: "没有可翻译的文本。",
    translationFailed: "翻译请求失败 ({status})", translationCancelled: "已取消翻译。", translationTimeout: "翻译超时，请稍后重试。",
    document: "文档", pdfPasswordNeeded: "需要 PDF 密码", jump: "跳转",
    extensionInvalidPdfUrl: "PDF 地址无效：请输入完整的 HTTP(S) 地址。",
    extensionInvalidPdfUrlCredentials: "PDF 地址无效：仅支持不含账号信息的 HTTP(S) 地址。",
    extensionPermissionApiUnavailable: "无法请求网站访问权限：扩展权限 API 不可用。",
    extensionMissingFileParam: "缺少要打开的 PDF 地址（file 参数）。",
    extensionCannotCheckPermission: "无法检查网站访问权限，不能打开此 PDF。",
    extensionOriginNotGranted: "尚未获得访问 {origin} 的权限，请先授权后再打开。",
    extensionMimeReadFailed: "读取 PDF MIME 流失败（HTTP {status}）。",
    extensionNoOriginalUrl: "没有可交给浏览器打开的原始 PDF 地址。",
    extensionCannotNotifyBackground: "无法通知扩展后台打开原始 PDF。",
    extensionOpenOriginalFailed: "浏览器未能打开原始 PDF，请重试。",
    extensionOpenOriginalFailedReason: "浏览器未能打开原始 PDF：{reason}，请重试。",
  },
  en: {
    modelIncompleteTranslation: "Translation did not complete ({reason}). Please try again.",
    fileNavigation: "File and navigation", open: "Open", openPdf: "Open PDF", originalPdf: "Original PDF",
    openOriginalPdf: "Open the original PDF in the browser", toggleSidebar: "Show or hide the outline sidebar",
    back: "Back", backHint: "Back (mouse side button / Alt+← / Backspace)", forward: "Forward",
    forwardHint: "Forward (mouse side button / Alt+→)", pageNumber: "Page number", pageJump: "Enter a page number and press Enter",
    currentPage: "Current page", noFile: "No file open", zoom: "Zoom", zoomOut: "Zoom out", zoomIn: "Zoom in",
    fitWidth: "Fit width", fitPage: "Fit page", search: "Search", more: "More", settings: "Settings",
    switchLight: "Switch to light theme", switchDark: "Switch to dark theme", sidebarMode: "Sidebar mode",
    outline: "Outline", expandAll: "Expand all", collapseAll: "Collapse all", closeSidebar: "Close sidebar",
    documentOutline: "Document outline", searchDocument: "Search document", clearSearch: "Clear search",
    previous: "Previous", next: "Next", previousHint: "Previous (Shift+Enter)", nextHint: "Next (Enter)", closeHint: "Close (Esc)", resizeSidebar: "Resize sidebar", chooseAgain: "Choose another file",
    openPdfFile: "Open a PDF", dropToRead: "Drop a file here to start reading", chooseFile: "Choose file…",
    translateSelection: "Translate selected text", translateChip: "Translate", dragTranslation: "Move the translation window; arrow keys also work",
    dragTranslationHint: "Drag to move the translation window", pinTranslation: "Pin translation window", unpinTranslation: "Unpin translation window",
    close: "Close", expandSource: "Show source", collapseSource: "Hide source", currentModel: "Current translation model",
    copyResult: "Copy translation", copied: "Copied", copyFailed: "Copy failed", passwordRequired: "PDF password required",
    encryptedHint: "This document is encrypted. Enter its password to open it.", password: "Password", cancel: "Cancel", save: "Save",
    translationSettings: "Translation settings", model: "Model", targetLanguage: "Translation language", interfaceLanguage: "Interface language",
    chineseSimplified: "简体中文", english: "English", autoTranslate: "Translate automatically after selecting text",
    servicePrivacy: "Service URL and privacy", localPrivacy: "The Base URL and API key are stored only in this browser. Translation requests are sent directly from your device to the configured endpoint.",
    apiBase: "API Base URL (OpenAI compatible)", extensionSettings: "Extension settings", passwordCancelled: "Password entry cancelled",
    passwordIncorrect: "Incorrect password. Try again.", opening: "Opening…", openFailed: "Could not open: {message}",
    noOutline: "This PDF has no outline.", unnamed: "Untitled", toggleBranch: "Expand or collapse", pageDescription: "Page {page}",
    searchPrompt: "Search results will appear here after you enter a keyword.", zeroResults: "0 results", noMatches: "No matches found.",
    previousResults: "Previous results", nextResults: "Next results", pageMeta: "Page {page} · {current}/{total}",
    locateFailed: "Could not locate result: {message}", partialIndex: "Some pages could not be indexed. Only available results are shown.",
    indexing: "Indexed {current}/{total}", searchFailed: "Search failed: {message}", setupTranslation: "Set up translation",
    retry: "Retry", textTooLong: "The selection is too long ({count} characters). Shorten it to {max} characters or fewer.",
    nothingToCopy: "There is nothing to copy", copySuccessAnnouncement: "Translation copied to the clipboard",
    copyFailureAnnouncement: "Copy failed. Check the browser's clipboard permission.", permissionDenied: "Access to the service URL was not granted. Settings were not saved.",
    saveFailed: "Could not save settings. Try again.", openOriginalFailed: "Could not open the original PDF.", openDocumentFailed: "Could not open the document.",
    modelLoadFailed: "✕ Could not load the model list: {message}", modelListEmptyWarning: "⚠ The request succeeded, but the provider returned no models, so the current model cannot be verified.",
    modelIdRequired: "⚠ Enter a model ID; an empty model cannot be verified.", modelFound: "✓ Found {model} in the model list ({count} models)",
    modelNotFound: "⚠ The current model was not found. The provider may have returned an incomplete list; a custom model ID may still work.",
    missingCredentials: "✕ Enter {fields} before checking the model list.", and: " and ", loadingModels: "Loading model list…",
    modelsLoaded: "Loaded {count} models. Type to filter.", noModels: "No available models were returned.", unableLoadModels: "Could not load the model list.",
    modelListRequestFailed: "Could not load the model list ({status})",
    configChanged: "Configuration changed. Waiting to check the model list again…", modelNoTranslation: "The model returned no translation.",
    apiKeyRequired: "No API key is configured. Open Settings first.", noText: "There is no text to translate.",
    translationFailed: "Translation request failed ({status})", translationCancelled: "Translation cancelled.", translationTimeout: "Translation timed out. Try again later.",
    document: "Document", pdfPasswordNeeded: "PDF password required", jump: "Open link",
    extensionInvalidPdfUrl: "Invalid PDF URL. Enter a full HTTP(S) address.",
    extensionInvalidPdfUrlCredentials: "Invalid PDF URL. Only HTTP(S) URLs without embedded credentials are supported.",
    extensionPermissionApiUnavailable: "Cannot request site access: the extension permissions API is unavailable.",
    extensionMissingFileParam: "No PDF URL to open (missing file parameter).",
    extensionCannotCheckPermission: "Cannot verify site access permission for this PDF.",
    extensionOriginNotGranted: "Access to {origin} has not been granted. Grant permission and try again.",
    extensionMimeReadFailed: "Could not read the PDF MIME stream (HTTP {status}).",
    extensionNoOriginalUrl: "No original PDF URL is available for the browser to open.",
    extensionCannotNotifyBackground: "Could not ask the extension background page to open the original PDF.",
    extensionOpenOriginalFailed: "The browser could not open the original PDF. Try again.",
    extensionOpenOriginalFailedReason: "The browser could not open the original PDF: {reason}. Try again.",
  }
};

let currentLocale = "zh-CN";

export function normalizeLocale(locale) {
  return SUPPORTED_LOCALES.has(locale) ? locale : "zh-CN";
}

export function setLocale(locale) {
  currentLocale = normalizeLocale(locale);
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

export function t(key, values = {}) {
  const template = messages[currentLocale]?.[key] ?? messages["zh-CN"]?.[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`);
}

export function applyDocumentTranslations(root = globalThis.document) {
  if (!root) return;
  const html = root.documentElement || root.ownerDocument?.documentElement;
  if (html) html.lang = currentLocale;
  const apply = (attribute, setter) => {
    for (const element of root.querySelectorAll?.(`[${attribute}]`) || []) {
      setter(element, t(element.getAttribute(attribute)));
    }
  };
  apply("data-i18n", (element, value) => { element.textContent = value; });
  apply("data-i18n-title", (element, value) => { element.title = value; });
  apply("data-i18n-aria", (element, value) => { element.setAttribute("aria-label", value); });
  apply("data-i18n-placeholder", (element, value) => { element.placeholder = value; });
  if (typeof globalThis.CustomEvent === "function") {
    globalThis.dispatchEvent?.(new CustomEvent("fast-pdf-viewer-language-change", { detail: { locale: currentLocale } }));
  }
}
