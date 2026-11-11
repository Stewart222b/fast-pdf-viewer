---
name: Fast PDF Viewer – AI Translation
description: Dark, tool-like reader chrome around a pdf.js page.
colors:
  night-shell: "#12141a"
  raised-deck: "#1b1e27"
  hover-plate: "#252a36"
  sidebar-well: "#161922"
  bubble-well: "#222733"
  chip-well: "#2a3140"
  hairline: "#2c3344"
  readout: "#e8eaef"
  muted-readout: "#9aa3b5"
  signal-blue: "#7aa2ff"
  signal-blue-strong: "#3d64d8"
  danger: "#f07178"
  primary-on-accent: "#ffffff"
typography:
  display:
    fontFamily: "Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "40px"
    fontWeight: 400
    letterSpacing: "0.08em"
    lineHeight: 1.2
  title:
    fontFamily: "Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.3
  body:
    fontFamily: "Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
spacing:
  control-gap: "8px"
  toolbar-pad-x: "14px"
  page-gap: "18px"
  toolbar-h: "56px"
  sidebar-w: "300px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue-strong}"
    textColor: "{colors.primary-on-accent}"
    rounded: "6px"
    padding: "8px 12px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.signal-blue-strong}"
    textColor: "{colors.primary-on-accent}"
  button-ghost:
    backgroundColor: "{colors.night-shell}"
    textColor: "{colors.readout}"
    rounded: "6px"
    padding: "8px 12px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.hover-plate}"
    textColor: "{colors.readout}"
  input-search:
    backgroundColor: "{colors.night-shell}"
    textColor: "{colors.readout}"
    rounded: "6px"
    padding: "0 4px 0 8px"
    height: "30px"
  chip-translate:
    backgroundColor: "{colors.chip-well}"
    textColor: "{colors.readout}"
    rounded: "6px"
    height: "28px"
    padding: "0 8px"
  card-bubble:
    backgroundColor: "{colors.bubble-well}"
    textColor: "{colors.readout}"
    rounded: "8px"
    padding: "10px"
    width: "420px"
---

# Design System: Fast PDF Viewer – AI Translation

> Current theme/search update: default to neutral dark chrome (#242424 ground, #303030 surfaces, #2b2b2b sidebar); the toolbar sun/moon button switches to the light palette and saves `fast-pdf-viewer-theme` locally. `web/js/theme.js` restores the preference before CSS loads. PDF paper remains unchanged. Search input, hit count and navigation live together at the top of the left search pane; only results scroll. The toolbar search button or Ctrl+F opens this pane, Escape closes it, and switching to outline retains the query/results. This supersedes the floating-search and light-only descriptions below.

> 2026-09-14 UI revision: the current reader uses neutral light chrome, superseding the dark-theme tokens and dark-only rules below. Current implementation tokens live in `web/styles.css`: white toolbar and floating surfaces, #e9e9e9 reading ground, #303030 text, #737373 secondary text, #1769aa interaction accent; 46px toolbar and 272px sidebar. Search opens on demand with its toolbar button or Ctrl+F and closes with Escape. The empty state is a file-opening prompt without branding or feature lists. Sidebar tabs use an underline; translation actions are unframed. Preserve ordinary reader conventions and existing reading/translation behavior; do not add brand motifs or decorative components. The remaining document describes the previous visual version for reference.

## Overview

**Creative North Star: "安静仪器"**

Chrome recedes so the PDF page can do the work. The incumbent UI is a dark, mostly flat instrument panel: system UI fonts, hairline dividers, and a spare blue accent used for the thing that is currently in play (open, outline, hit, selection). Density is for hours inside a technical manual, not for a marketing site.

This file records the **shipped** look on `feat/ui-redesign` (post–PR #5). A later redesign may replace this world; until then, new chrome should match these tokens rather than invent a second palette.

**Key Characteristics:**
- Dark-only (`color-scheme: dark`); no light theme in code.
- Tonal stacking for structure; one shared drop shadow for floating chrome.
- System sans (Segoe UI / PingFang SC / Microsoft YaHei); no display typeface except the empty-state wordmark.
- 8–12px corner radii on controls; the page itself stays rectangular.

## Colors

One cool-dark chassis with a single blue signal. Danger red is reserved for errors.

### Primary
- **信号蓝** (`{colors.signal-blue}`): focus, active outline, checked zoom item, chip hover. Stronger fill (`{colors.signal-blue-strong}`) is the primary button (打开); the fill is darkened to hold white text at 4.5:1.

### Neutral
- **夜壳** (`{colors.night-shell}`): app ground.
- **抬升面** (`{colors.raised-deck}`): toolbar and menus sitting one step above the ground.
- **悬停板** (`{colors.hover-plate}`): hover/active non-primary controls.
- **目录井** (`{colors.sidebar-well}`): outline/search sidebar (slightly off the ground, not a tokenized CSS variable).
- **发丝线** (`{colors.hairline}`): sidebar edge, bubble action divider, menu hover wash — never a full card outline on toolbar seats.
- **读数** (`{colors.readout}`): primary text.
- **弱读数** (`{colors.muted-readout}`): secondary labels, search counts, empty-state hints.

### Named Rules
**The One Signal Rule.** Blue is for the current action or focus. Do not paint large surfaces blue.

**The Page Is Not Chrome Rule.** The PDF sheet stays paper-white from the document; chrome never tints the page.

## Typography

**Display Font:** Segoe UI / PingFang SC / Microsoft YaHei (system sans)
**Body Font:** same stack
**Label/Mono Font:** same stack; tabular nums on zoom and page index

**Character:** Instrument readout, not editorial. Chinese UI copy with English industry terms left in English.

### Hierarchy
- **Display** (regular, 40px, letter-spacing 0.08em): empty-state “Fast PDF Viewer – AI Translation” wordmark only.
- **Title** (500, 13px, 弱读数): toolbar document title — quiet, ellipsized, never competing with the page.
- **Body** (400, 14px, inherit): chrome labels, outline rows, bubble copy.
- **Label** (400, 12px): search hit counts and compact meta.

### Named Rules
**The One Family Rule.** Do not introduce Inter, a second display face, or icon fonts for chrome. The PDF text layer uses pdf.js faces, not this stack.

## Layout

Top **toolbar** is 56px, always visible, never auto-hidden: left file/nav cluster, fluid center title, right tool cluster, 14px horizontal padding. Permanent seats scan as six clusters separated by 22px hairline dividers (tight 2px inside a group): 文件与导航 (打开 / 目录 / 历史←→) | 页码 | 标题 | 缩放 (− label +) | 搜索(+ 问答 on desktop) | 更多 (用浏览器打开 / 文档属性 / 主题 / 设置). The title is the only elastic column, so it centers on the space between the two fixed clusters — never on the viewport center — and its full-name popover anchors to the title text, not the window middle. Zoom and history each read as one seat. Icons are a shared inline SVG stroke sprite (folder, list, arrows, chevrons, minus/plus, search, ask, settings, copy, ×); 打开 keeps a text label with its icon, 目录 is icon-only (list) with title/aria-label, and the rest are icon-only. The title carries the full filename in its tooltip for truncated names. Clicking it opens a popover with the filename and the current outline path (chapter › section), using the same dest as the highlighted outline row; ancestor crumbs jump there. The page box is an editable control (type + Enter); with no document open it reads — / — and the input is disabled. Below it, a **flex workspace**: left outline sidebar, `#viewer-wrap`, and (from 1280px) a right search/ask rail. Page stack gap is 18px.

**Panels default shut.** Both rails boot collapsed so the page is full-width until the user opens them. Closing collapses to zero flex width so no gutter remains, and collapsed panels are `inert`.

**≥1280px dual-rail.** Left rail is outline only: the pane head puts 「目录」 on the same row as expand/collapse (and close). Right rail holds 搜索 / 问答 (beta) as a segmented switch; search button / Ctrl+F and the ask toolbar button open the right rail without closing the outline. Esc closes the right rail first and can leave the outline open. Search and ask panes are reparented into `#rail` at this breakpoint (one DOM copy, no duplicated markup).

**<1280px compact.** Keep the previous single left sidebar with 目录 / 搜索 / 问答 (beta) tabs. The ask toolbar button is hidden; ask stays a left-tab. ≤900px overlay behavior is unchanged and never applies a right rail.

**Tight chrome.** The toolbar keeps one shape from 1024px up: left cluster, centered filename, right cluster with a source-aware file action immediately before 更多. 更多 is the only secondary entry at every width — it always opens the same popover (用浏览器打开 / 文档属性 / 主题 / 设置) instead of turning into an inline strip, so no control changes seats when the window moves a few pixels. At ≤900px the centered title drops out and 更多 gains a 查看完整文件名 row; the **sidebar becomes an overlay panel** (page keeps full width, panel floats with a shadow); at ≤620px the toolbar search collapses to a search entry button that expands into a floating field, and the zoom label compresses to its value. Below **480px** the permanent seats stop fitting on one row, so the least informative give way in order — the 打开 label, the page total (with its slash, never leaving a bare “/”), and a disabled 前进 button — because the alternative is the right cluster overflowing its grid track and painting over the page box. Below **380px** the zoom chip also folds away (keyboard and pinch still zoom), leaving 打开 / 目录 / 历史 / 页码 / 搜索 / 更多 as the row that always fits. First open fits the page; afterwards the user's zoom choice is respected.

**PDF opening.** Show loading feedback from extension startup through MIME stream reception and PDF.js preparation. Use a 280px-wide, 3px accent progress bar with a 160ms width transition. Known byte totals show received / total sizes and percentage; unknown or encoded lengths show an indeterminate bar with received bytes. After reception, preparation has its own indeterminate state instead of a fabricated percentage. Hide the bar on ready, failure or an empty startup; ignore old progress after document switches. Respect reduced motion.

**PDF export.** The file action uses a download-to-tray icon and Download PDF for HTTP(S) sources, or a save icon and Save a copy for explicitly local files (picker/drop, file URLs, native paths). Unknown Blob origins use Download PDF. Ctrl/Cmd+S invokes the same action. Export the retained original Blob or the current PDF.js document's complete original bytes, with a sanitized .pdf filename; never write translation or Q&A into the PDF. The action is hidden until a document is ready, disabled during its export, and drops late results after a document switch. Failures show a temporary notice without blocking the reading surface.

**Large desktop.** From **1920px up** the reader chrome scales in three steps while the PDF page keeps its "fit page" behavior: 1920+ uses a 48px toolbar, 36px buttons, 14px chrome type and a 320px sidebar/rail; 2560+ (2K) uses 56px / 42px / 15px / 360px; 3840+ (4K) uses 64px / 48px / 17px / 420px. Sidebar and right-rail resize bounds widen with each step (320-560, 360-640, 420-720). Below 1920px nothing changes, so the compact layout above is untouched.

**Viewer status.** `#viewer-status` in the main viewer owns open feedback: 正在打开… while loading, 打开失败 + cause with a 重新选择文件 action on failure — never hidden inside the default-collapsed outline pane.

## Elevation & Depth

Flat at rest and flat over the page. Structure is darker vs slightly-lighter fills; the viewer ground is a single flat fill with no radial glow. Floating panels (zoom menu, translate bubble, 译 chip, modal, model menu) commit to a defined hairline edge and carry no diffuse shadow. The one shadow left in the reader belongs to the paper page itself, which has no border — edge or elevation, never both.

### Shadow Vocabulary
- **纸面** (`box-shadow: 0 4px 16px rgba(0, 0, 0, 0.32)`): the PDF sheet only. Do not put it on bordered panels.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat until they float over the page.

## Shapes

8px on floating containers (translate bubble, zoom/model menus, modal); 6px on buttons, inputs, and the search control; 4px on tiny buttons and dense menu rows. The PDF page and the viewer canvas stay sharp rectangles.

## Components

### Buttons
- **Shape:** 6px corners, 36px tall, 8×12 padding (tiny 28px/4px).
- **Primary:** 信号蓝强底、白字、无描边；hover 提高亮度。打开 is primary only in the empty state (plus the empty-state 打开 PDF button); once a document is open it steps down to a normal toolbar control and keeps its 打开 label.
- **Toolbar ghost:** 无框、无底，靠组间距与发丝分隔线分组；hover 悬停板；active 非主按钮字变信号蓝，不套描边。
- **Dialog/sidebar buttons:** keep the quiet tiny button; no dual-weight wall of 36px hairline cards.
- **Disabled:** 40% opacity.

### Chips
- **译 chip:** 28px tall, 8px radius, `#2a3140` fill, defined hairline edge, no diffuse shadow; hover uses 信号蓝 on border and type.

### Cards / Containers
- **Translate bubble:** 8px radius, `#222733`, 10px pad, max 420px (520/580/680px at 1920/2560/3840), hairline edge, no diffuse shadow. Translation first, actions last: source/result body on top, 取消/复制/关闭 row pinned below a divider — a selection extension, not a mini-chat. Source is smaller and dimmer than the translation (12px muted vs 14px result, no titles); **actions stay fully opaque** — hierarchy comes from type size and spacing, never faded buttons. Long sources (>400 chars) fold behind an 展开原文 / 收起原文 toggle. Thinking stays folded behind 思考过程 when the display setting is on; it stays off by default. Missing API key shows **设置翻译** (opens settings, keeps the selection); network errors show 重试.
- **Modal:** raised deck, 16px radius, hairline edge, no diffuse shadow. Settings leads with common fields (Key / 模型 / 目标语言 / 自动翻译 / 思考强度 / 显示思维链); Base URL and the local-only storage note live behind an 高级 disclosure. The card is the scroll container, but the 取消 / 保存 row is sticky to its bottom edge with a hairline above it, so a short window never hides the only way to confirm the form. Dialogs trap focus, take initial focus inside, isolate background reading shortcuts, and restore focus to the trigger on close.
- **Sidebar / rail:** ~272–480px (wider on large desktop), `#161922`, hairline edge; inner pane translates, width does not squeeze type. Compact left head carries 目录 / 搜索 / 问答 (beta); desktop left head is outline-only, desktop right head is 搜索 / 问答 (beta). Outline rows highlight by **page range** (last section at or before the current page) with a 第 X 页 tooltip hint. Ask citations reuse the search-hit row style (meta + snippet, accent bar when current).

### Inputs / Fields
- **Search:** compact 30px control with a hairline edge, search icon, query, and clear (×) — never a naked label or a SaaS-wide bar. Count, prev/next, and hits live only in the sidebar search mode. Sidebar results never scroll horizontally (`overflow-x: hidden`, wrapping snippets); the current hit gets a thin accent bar on a quiet wash, and hits are separated by hairlines, not cards.
- **Ask:** empty pane is a centered prompt (chat-question icon, title 关于这份 PDF，你想了解什么？, hint 可以帮你总结内容、查找参数或解答技术问题). Composer sits at the bottom as one field: a one-line textarea that grows with wraps up to 160px, full-width text area above a dedicated bottom action row, with the send circle on the right (DeepSeek Harness 34px blue circle, 0.4 opacity when empty, up-arrow when there is a question, stop square while answering). After the first turn the placeholder becomes 继续提问.... User questions sit in a right-aligned bubble. Copy and retry use 14px icons in 24px hit areas, with a 4px gap under the answer. The scrollable thread ends with 40px of breathing room above the composer. 清理 lives at the bottom-left of the composer in the dedicated action row, opposite send/stop. Its menu opens upward and is visible once there is a turn. Answers stream above the composer as one thread for the open PDF. No avatars, no conversation list, no multiple threads. The visible thread retains the current PDF's questions and answers until cleared or another PDF opens. Request history has no fixed turn cap: earlier Q&A is summarized by the configured model when the estimated context budget is reached, preserving recent full turns. Context length comes from the loaded model list when available; otherwise a conservative 32,768-token budget is used. Document text, tool results and output have reserved space. Summarization usage is included in the question's token meter. After an answer, the composer foot keeps usage and coverage on one 24px row (`35.1k tok · 缓存命中 85%` plus `检索 1 次 · 12 页`), with 8px above and below. The usage line is plain until hover or while its popover is open, when it becomes a compact pill. Click it to open a popover above — Token 用量 as the head, then cache / output rows. Click again or click outside to close. Page lists live in 读取记录, not the foot. Citations appear only as clickable page references inside the answer, without a separate citation list. Markdown answers render GFM pipe tables (hairline rows, sideways scroll in the pane). Thinking stays folded behind 思考过程 when the display setting is on: a same-level disclosure like 读取记录, muted text in the thread, no nested card or inner scrollbar. Retrieval covers the whole indexed document: keyword hits pack a window around the match plus neighboring pages, overview questions sample first/last/interior pages, chapter questions (`第五章` / `chapter 5`) sample the outline page range (or a running-header run) instead of the whole book, unmatched questions fall back to the current page and a coverage sample, and greetings use the current page as an anchor. The model only sees those packed pages plus outline titles — never the full PDF.
- **Page index:** borderless text input, tabular nums, no spinner; hover/focus reveals the edge.

### Navigation
- Toolbar is the only global nav: 打开 (icon+label) / 目录 toggle (list icon), history, page, zoom, search, settings. 目录 toggles the left outline rail; the 「目录」 word lives in the outline pane head next to expand/collapse, not on the toolbar.
- Page stepping in chrome is the page box (type + Enter) plus ↑/↓/PageUp/PageDown keys; history is ←/→ plus Alt+←/→ and mouse side buttons.

### Signature: 划词气泡
Fixed overlay anchored to the selection focus end, clamped inside `#viewer-wrap`. Prefers the side with room and re-tries the other side when clamping would cover the selection line. Source small muted, translation prominent, actions after. Esc or outside click closes; streaming caret while tokens arrive.

## Do's and Don'ts

### Do:
- **Do** keep chrome dark and the PDF page paper-white.
- **Do** use 信号蓝 only for the live control or focus.
- **Do** slide the sidebar as a whole; never animate inner text width.
- **Do** collapse a closed sidebar to zero flex width so the page recenters.

### Don't:
- **Don't** introduce a light theme or purple SaaS gradient.
- **Don't** nest cards inside cards on the reading surface.
- **Don't** add Inter, icon-tile headers, or bounce easing.
- **Don't** put Chat chrome in the reader (avatars, conversation list, multiple threads); translation stays 划词. 问答 is one thread per open PDF, composer at the bottom of the pane (desktop: right rail; compact: left tab).
- **Don't** use text glyphs (← → − + ⚙ × ⌄) for toolbar chrome; the inline stroke sprite owns icons.
