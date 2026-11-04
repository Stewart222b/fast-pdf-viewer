"use strict";

const AUTO_OPEN_KEY = "autoOpenPdf";
const READER_SETTINGS_KEY = "fast-pdf-viewer-settings";
const DEFAULT_SETTINGS = { [AUTO_OPEN_KEY]: false, [READER_SETTINGS_KEY]: {} };
const EXTRA_LOCALES = ["zh-TW", "ja", "ko", "de", "fr", "es"];
const EXTRA_ROWS = {
  pageTitle: ["Fast PDF Viewer – AI Translation 設定", "Fast PDF Viewer – AI Translation 設定", "Fast PDF Viewer – AI Translation 설정", "Fast PDF Viewer – AI Translation Einstellungen", "Paramètres de Fast PDF Viewer – AI Translation", "Configuración de Fast PDF Viewer – AI Translation"],
  brandHome: ["Fast PDF Viewer – AI Translation 設定首頁", "Fast PDF Viewer – AI Translation 設定ホーム", "Fast PDF Viewer – AI Translation 설정 홈", "Fast PDF Viewer – AI Translation Einstellungsstartseite", "Accueil des paramètres de Fast PDF Viewer – AI Translation", "Inicio de configuración de Fast PDF Viewer – AI Translation"],
  extensionSettings: ["擴充功能設定", "拡張機能の設定", "확장 프로그램 설정", "Erweiterungseinstellungen", "Paramètres de l’extension", "Configuración de la extensión"],
  intro: ["讓 PDF 連結快速進入 Fast PDF Viewer – AI Translation，也能隨時返回閱讀器。", "PDF リンクを Fast PDF Viewer – AI Translation ですばやく開き、いつでもリーダーに戻れます。", "Fast PDF Viewer – AI Translation에서 PDF 링크를 빠르게 열고 언제든 리더로 돌아갈 수 있습니다.", "PDF-Links schnell in Fast PDF Viewer – AI Translation öffnen und jederzeit zum Reader zurückkehren.", "Ouvrez rapidement les liens PDF dans Fast PDF Viewer – AI Translation et revenez au lecteur à tout moment.", "Abre enlaces PDF rápidamente en Fast PDF Viewer – AI Translation y vuelve al lector cuando quieras."],
  pdfHandling: ["PDF 處理", "PDF の処理", "PDF 처리", "PDF-Verarbeitung", "Gestion des PDF", "Gestión de PDF"],
  handlingDescription: ["選擇瀏覽器遇到 PDF 時的預設行為。", "PDF を開くときのブラウザーの動作を選択します。", "브라우저가 PDF를 발견했을 때의 동작을 선택하세요.", "Wählen Sie das Browserverhalten beim Öffnen von PDFs.", "Choisissez le comportement du navigateur face à un PDF.", "Elige qué hace el navegador cuando encuentra un PDF."],
  autoOpen: ["自動開啟 PDF", "PDF を自動的に開く", "PDF 자동 열기", "PDFs automatisch öffnen", "Ouvrir les PDF automatiquement", "Abrir PDF automáticamente"],
  autoOpenDescription: ["偵測到 PDF 連結時，自動交由 Fast PDF Viewer – AI Translation 閱讀。", "検出した PDF リンクを Fast PDF Viewer – AI Translation で自動的に開きます。", "감지한 PDF 링크를 Fast PDF Viewer – AI Translation에서 자동으로 엽니다.", "Erkannte PDF-Links automatisch in Fast PDF Viewer – AI Translation öffnen.", "Ouvrir automatiquement les liens PDF détectés dans Fast PDF Viewer – AI Translation.", "Abrir automáticamente los enlaces PDF detectados en Fast PDF Viewer – AI Translation."],
  permissions: ["權限說明", "権限", "권한 안내", "Berechtigungen", "Autorisations", "Permisos"],
  permissionDescription: ["擴充功能已取得 http:// 與 https:// 網站的存取權限，用於開啟線上 PDF、更新承載 PDF 的分頁標題及偵測 PDF 請求；不會讀取網頁內文。支援原生 PDF 接管的瀏覽器使用內建功能；舊版瀏覽器啟用自動開啟時，會另行要求選用的 webRequest 權限。", "拡張機能はオンライン PDF の表示、PDF タブのタイトル更新、PDF 要求の検出のため http:// と https:// サイトにアクセスします。Web ページの本文は読み取りません。対応ブラウザーでは内蔵 PDF 処理を使用します。古いブラウザーでは自動表示を有効にすると任意の webRequest 権限を要求します。", "온라인 PDF 열기, PDF 탭 제목 갱신 및 PDF 요청 감지를 위해 http:// 및 https:// 사이트에 접근합니다. 웹페이지 본문은 읽지 않습니다. 지원 브라우저는 기본 PDF 처리 기능을 사용합니다. 이전 브라우저에서는 자동 열기를 켤 때 선택적 webRequest 권한을 요청합니다.", "Die Erweiterung greift auf http://- und https://-Seiten zu, um Online-PDFs zu öffnen, PDF-Tabtitel zu aktualisieren und PDF-Anfragen zu erkennen. Webseiteninhalte werden nicht gelesen. Unterstützte Browser nutzen die native PDF-Verarbeitung. Ältere Browser fragen beim Aktivieren nach der optionalen webRequest-Berechtigung.", "L’extension accède aux sites http:// et https:// pour ouvrir les PDF en ligne, actualiser leurs titres d’onglets et détecter les requêtes PDF. Elle ne lit pas le contenu des pages Web. Les navigateurs compatibles utilisent la gestion PDF native. Les anciens demandent l’autorisation facultative webRequest lors de l’activation.", "La extensión accede a sitios http:// y https:// para abrir PDF en línea, actualizar los títulos de sus pestañas y detectar solicitudes PDF. No lee el contenido de las páginas web. Los navegadores compatibles usan la gestión nativa de PDF. Los antiguos solicitan el permiso opcional webRequest al activar la apertura automática."],
  quickActions: ["快捷操作", "クイック操作", "빠른 작업", "Schnellaktionen", "Actions rapides", "Acciones rápidas"],
  openReader: ["開啟閱讀器", "リーダーを開く", "리더 열기", "Reader öffnen", "Ouvrir le lecteur", "Abrir lector"],
  extensionDetails: ["檢視擴充功能詳細資料", "拡張機能の詳細を表示", "확장 프로그램 세부정보 보기", "Erweiterungsdetails anzeigen", "Voir les détails de l’extension", "Ver detalles de la extensión"],
  footerNote: ["PDF 檔案仍保留在本機；可在瀏覽器的擴充功能管理頁調整其他權限。", "PDF ファイルはこの端末に保存されます。追加の権限はブラウザーの拡張機能管理ページで変更できます。", "PDF 파일은 기기에 남아 있습니다. 브라우저 확장 프로그램 관리 페이지에서 추가 권한을 조정할 수 있습니다.", "PDF-Dateien bleiben auf Ihrem Gerät. Weitere Berechtigungen lassen sich in der Erweiterungsverwaltung ändern.", "Les PDF restent sur votre appareil. Vous pouvez modifier les autres autorisations dans la gestion des extensions du navigateur.", "Los PDF permanecen en tu dispositivo. Puedes ajustar otros permisos desde la página de extensiones del navegador."],
  privacy: ["閱讀隱私說明", "プライバシーについて", "개인정보 안내 읽기", "Datenschutzhinweise lesen", "Lire la notice de confidentialité", "Leer el aviso de privacidad"],
  requestingPermission: ["目前瀏覽器不支援原生 PDF 接管，正在要求選用的 webRequest 權限…", "このブラウザーは PDF のネイティブ処理に対応していません。任意の webRequest 権限を要求中…", "이 브라우저는 기본 PDF 처리를 지원하지 않습니다. 선택적 webRequest 권한 요청 중…", "Keine native PDF-Verarbeitung. Optionale webRequest-Berechtigung wird angefordert…", "Gestion PDF native indisponible. Demande de l’autorisation facultative webRequest…", "La gestión nativa de PDF no está disponible. Solicitando el permiso opcional webRequest…"],
  permissionDenied: ["未取得 webRequest 權限，設定維持關閉。", "webRequest 権限が許可されませんでした。設定はオフのままです。", "webRequest 권한이 거부되었습니다. 설정은 꺼진 상태로 유지됩니다.", "webRequest-Berechtigung nicht erteilt. Einstellung bleibt aus.", "Autorisation webRequest refusée. L’option reste désactivée.", "No se concedió el permiso webRequest. La opción sigue desactivada."],
  enabled: ["已啟用自動開啟 PDF。", "PDF の自動表示を有効にしました。", "PDF 자동 열기가 켜졌습니다.", "Automatisches Öffnen von PDFs aktiviert.", "Ouverture automatique des PDF activée.", "Apertura automática de PDF activada."],
  disabled: ["已停用自動開啟 PDF。", "PDF の自動表示を無効にしました。", "PDF 자동 열기가 꺼졌습니다.", "Automatisches Öffnen von PDFs deaktiviert.", "Ouverture automatique des PDF désactivée.", "Apertura automática de PDF desactivada."],
  saveFailed: ["無法儲存設定，請稍後重試。", "設定を保存できません。後で再試行してください。", "설정을 저장할 수 없습니다. 나중에 다시 시도하세요.", "Einstellung konnte nicht gespeichert werden. Später erneut versuchen.", "Impossible d’enregistrer le paramètre. Réessayez plus tard.", "No se pudo guardar la configuración. Inténtalo más tarde."],
  loadFailed: ["無法讀取設定，請重新開啟此頁面。", "設定を読み込めません。このページを開き直してください。", "설정을 읽을 수 없습니다. 이 페이지를 다시 여세요.", "Einstellungen konnten nicht gelesen werden. Seite erneut öffnen.", "Impossible de lire les paramètres. Rouvrez cette page.", "No se pudo leer la configuración. Vuelve a abrir esta página."],
};
const MESSAGES = {
  ...Object.fromEntries(EXTRA_LOCALES.map((locale, index) => [locale,
    Object.fromEntries(Object.entries(EXTRA_ROWS).map(([key, values]) => [key, values[index]])),
  ])),
  "zh-CN": {
    pageTitle: "Fast PDF Viewer – AI Translation 设置", brandHome: "Fast PDF Viewer – AI Translation 设置首页",
    extensionSettings: "扩展设置", intro: "让 PDF 链接更快进入 Fast PDF Viewer – AI Translation，也可以随时回到阅读器。",
    pdfHandling: "PDF 处理", handlingDescription: "选择浏览器遇到 PDF 时的默认行为。", autoOpen: "自动打开 PDF",
    autoOpenDescription: "检测到 PDF 链接时，自动交给 Fast PDF Viewer – AI Translation 阅读。", permissions: "权限说明",
    permissionDescription: "扩展在安装时已获得 http:// 和 https:// 站点的访问权限，用于打开在线 PDF、向承载 PDF 的标签页写入标题和检测 PDF 请求；扩展不读取网页正文。支持原生 PDF 接管的浏览器使用浏览器自带能力；较旧浏览器启用自动打开时，会在确认后额外申请可选的 webRequest 权限。",
    quickActions: "快捷操作", openReader: "打开阅读器", extensionDetails: "查看扩展详情",
    footerNote: "PDF 文件仍保留在本机；你可以在浏览器的扩展管理页调整更多权限。", privacy: "阅读隐私说明",
    requestingPermission: "当前浏览器不支持原生 PDF 接管，正在请求可选的 webRequest 权限…",
    permissionDenied: "未获得 webRequest 权限，设置保持关闭。", enabled: "已开启自动打开 PDF。", disabled: "已关闭自动打开 PDF。",
    saveFailed: "无法保存设置，请稍后重试。", loadFailed: "无法读取设置，请重新打开此页面。",
  },
  en: {
    pageTitle: "Fast PDF Viewer – AI Translation Settings", brandHome: "Fast PDF Viewer – AI Translation settings home",
    extensionSettings: "Extension settings", intro: "Open PDF links quickly in Fast PDF Viewer – AI Translation and return to the reader at any time.",
    pdfHandling: "PDF handling", handlingDescription: "Choose what the browser does when it encounters a PDF.", autoOpen: "Open PDFs automatically",
    autoOpenDescription: "Open detected PDF links automatically in Fast PDF Viewer – AI Translation.", permissions: "Permissions",
    permissionDescription: "The extension has access to http:// and https:// sites so it can open online PDFs, update the title of tabs that host PDFs, and detect PDF requests. It does not read webpage content. Browsers with native PDF handling use the built-in capability. Older browsers ask for the optional webRequest permission when this setting is enabled.",
    quickActions: "Quick actions", openReader: "Open reader", extensionDetails: "View extension details",
    footerNote: "PDF files remain on your device. You can adjust additional permissions from the browser's extension management page.", privacy: "Read the privacy notice",
    requestingPermission: "This browser does not support native PDF handling. Requesting the optional webRequest permission…",
    permissionDenied: "The webRequest permission was not granted. The setting remains off.", enabled: "Automatic PDF opening is enabled.", disabled: "Automatic PDF opening is disabled.",
    saveFailed: "Could not save the setting. Try again later.", loadFailed: "Could not read settings. Reopen this page.",
  },
};
let uiLanguage = "zh-CN";

function tr(key) {
  return MESSAGES[uiLanguage]?.[key] || MESSAGES["zh-CN"][key] || key;
}

function applyTranslations() {
  if (document.documentElement) document.documentElement.lang = uiLanguage;
  for (const element of document.querySelectorAll?.("[data-i18n]") || []) element.textContent = tr(element.dataset.i18n);
  for (const element of document.querySelectorAll?.("[data-i18n-aria]") || []) element.setAttribute("aria-label", tr(element.dataset.i18nAria));
  if (typeof globalThis.Event === "function") globalThis.dispatchEvent?.(new Event("fast-pdf-viewer-language-change"));
}
const HOST_ACCESS = {
  permissions: ["webRequest"],
  origins: ["http://*/*", "https://*/*"],
};

const autoOpenInput = document.getElementById("auto-open-pdf");
const openReaderButton = document.getElementById("open-reader");
const extensionDetailsLink = document.getElementById("extension-details");
const settingsStatus = document.getElementById("settings-status");

function setStatus(message, kind = "") {
  settingsStatus.textContent = message;
  settingsStatus.dataset.kind = kind;
}

async function setMimeHandlerEnabled(enabled) {
  const mimeHandler = chrome.mimeHandler;
  if (!mimeHandler || typeof mimeHandler.setMimeHandlerOptions !== "function") {
    return;
  }

  await mimeHandler.setMimeHandlerOptions("application/pdf", { enabled });
}

function hasNativeMimeHandler() {
  return typeof chrome.mimeHandler?.setMimeHandlerOptions === "function";
}

async function saveAutoOpenSetting(enabled) {
  await chrome.storage.local.set({ [AUTO_OPEN_KEY]: enabled });
}

function getBrowserUiLanguage() {
  for (const language of [...(globalThis.navigator?.languages || []), globalThis.navigator?.language]) {
    const locale = matchUiLanguage(language);
    if (locale) return locale;
  }
  return "zh-CN";
}

function matchUiLanguage(value) {
  const tag = String(value || "").replaceAll("_", "-").toLowerCase();
  if (/^zh(?:-|$)/.test(tag)) return /(?:^|-)hant(?:-|$)|(?:^|-)(tw|hk|mo)(?:-|$)/.test(tag) ? "zh-TW" : "zh-CN";
  const language = tag.split("-")[0];
  return Object.hasOwn(MESSAGES, language) ? language : null;
}

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const readerSettings = settings[READER_SETTINGS_KEY] || {};
  const savedLanguage = matchUiLanguage(readerSettings.uiLanguage);
  const hasSavedLanguage = savedLanguage !== null;
  uiLanguage = readerSettings.uiLanguageSelected === false || !hasSavedLanguage
    ? getBrowserUiLanguage()
    : savedLanguage;
  applyTranslations();
  autoOpenInput.checked = settings[AUTO_OPEN_KEY] === true;
}

async function handleAutoOpenChange() {
  const enabled = autoOpenInput.checked;
  autoOpenInput.disabled = true;

  try {
    if (enabled) {
      if (hasNativeMimeHandler()) {
        await setMimeHandlerEnabled(true);
      } else {
        setStatus(tr("requestingPermission"));

        // Keep this request in the checkbox change handler: the browser requires a user gesture.
        const granted = await chrome.permissions.request(HOST_ACCESS);
        if (!granted) {
          autoOpenInput.checked = false;
          await saveAutoOpenSetting(false);
          setStatus(tr("permissionDenied"), "warning");
          return;
        }
      }

      await saveAutoOpenSetting(true);
      setStatus(tr("enabled"), "success");
    } else {
      await saveAutoOpenSetting(false);
      await setMimeHandlerEnabled(false);
      setStatus(tr("disabled"), "success");
    }
  } catch (error) {
    if (enabled) {
      autoOpenInput.checked = false;
      await Promise.allSettled([
        saveAutoOpenSetting(false),
        setMimeHandlerEnabled(false),
      ]);
      console.error("Failed to enable automatic PDF handling", error);
    } else {
      console.error("Failed to disable automatic PDF handling", error);
    }
    setStatus(tr("saveFailed"), "error");
  } finally {
    autoOpenInput.disabled = false;
  }
}

function isReaderUrl(value, expectedUrl) {
  try {
    const actual = new URL(value);
    const expected = new URL(expectedUrl);
    return actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

async function openReader() {
  const readerUrl = chrome.runtime.getURL("web/index.html");
  const tabs = await chrome.tabs.query({});
  const readerTab = tabs.find((tab) => isReaderUrl(tab.url, readerUrl));
  if (!readerTab) {
    await chrome.tabs.create({ url: readerUrl });
    return;
  }

  if (readerTab.windowId != null) {
    await chrome.windows.update(readerTab.windowId, { focused: true });
  }
  await chrome.tabs.update(readerTab.id, { active: true });
}

function configureExtensionDetailsLink() {
  extensionDetailsLink.href = `chrome://extensions/?id=${chrome.runtime.id}`;
}

async function initialize() {
  configureExtensionDetailsLink();
  openReaderButton.addEventListener("click", openReader);
  autoOpenInput.disabled = true;
  autoOpenInput.addEventListener("change", handleAutoOpenChange);

  try {
    await loadSettings();
    autoOpenInput.disabled = false;
  } catch (error) {
    autoOpenInput.disabled = true;
    setStatus(tr("loadFailed"), "error");
    console.error("Failed to load extension settings", error);
  }
}

initialize();
