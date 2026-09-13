---
name: 速览 Fast PDF Viewer
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

# Design System: 速览 Fast PDF Viewer

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
- **Display** (regular, 40px, letter-spacing 0.08em): empty-state “速览” wordmark only.
- **Title** (500, 13px, 弱读数): toolbar document title — quiet, ellipsized, never competing with the page.
- **Body** (400, 14px, inherit): chrome labels, outline rows, bubble copy.
- **Label** (400, 12px): search hit counts and compact meta.

### Named Rules
**The One Family Rule.** Do not introduce Inter, a second display face, or icon fonts for chrome. The PDF text layer uses pdf.js faces, not this stack.

## Layout

Top **toolbar** is 56px, always visible, never auto-hidden: left file/nav cluster, fluid center title, right tool cluster, 14px horizontal padding. Permanent seats scan as six clusters separated by 22px hairline dividers (tight 2px inside a group): 文件与导航 (打开 / 目录 / 历史←→) | 页码 | 标题 | 缩放 (− label +) | 搜索框 | 更多 (设置). Zoom and history each read as one seat. Icons are a shared inline SVG stroke sprite (folder, panel, arrows, chevrons, minus/plus, search, settings, copy, ×); 打开 and 目录 keep text labels with icons, the rest are icon-only with titles and aria-labels. The title carries the full filename in its tooltip for truncated names. The page box is an editable control (type + Enter); with no document open it reads — / — and the input is disabled. Below it, a **flex workspace**: outline/search sidebar plus `#viewer-wrap` which owns remaining width and recenters the page. Page stack gap is 18px.

**Sidebar defaults shut.** The sidebar boots collapsed and stays collapsed for empty state and no-outline PDFs, so the page is full-width until the user toggles 目录. Closing collapses to zero flex width so no gutter remains, and the collapsed panel is `inert` so its close button never enters the Tab order. 目录 has exactly one toolbar entry; **inside the open sidebar head** a light 目录 / 搜索 segmented switch flips modes without clearing state. 目录 always means outline (open on outline; outline-open toggles shut; search-open flips back to outline); searching switches to search mode and opens the panel; the query and hits persist across mode flips. Search input lives in the toolbar; hit count, prev/next, and the result list live only in the sidebar search mode — never both.

**Tight chrome.** At ≤1020px the center title drops out; at ≤900px the forward button and wide search shrink and the **sidebar becomes an overlay panel** (page keeps full width, panel floats with a shadow); at ≤620px the toolbar search collapses to a search entry button that expands into a floating field, and the zoom label compresses to its value. First open fits page width; afterwards the user's zoom choice is respected.

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
- **Translate bubble:** 8px radius, `#222733`, 10px pad, max 420px, hairline edge, no diffuse shadow. Translation first, actions last: source/result body on top, 取消/复制/关闭 row pinned below a divider — a selection extension, not a mini-chat. Source is smaller and dimmer than the translation (12px muted vs 14px result, no titles); **actions stay fully opaque** — hierarchy comes from type size and spacing, never faded buttons. Long sources (>400 chars) fold behind an 展开原文 / 收起原文 toggle. Missing API key shows **设置翻译** (opens settings, keeps the selection); network errors show 重试.
- **Modal:** raised deck, 16px radius, hairline edge, no diffuse shadow. Settings leads with common fields (Key / 模型 / 目标语言 / 自动翻译); Base URL and the local-only storage note live behind an 高级 disclosure. Dialogs trap focus, take initial focus inside, isolate background reading shortcuts, and restore focus to the trigger on close.
- **Sidebar:** 300px, `#161922`, hairline right edge; inner pane translates, width does not squeeze type. Head carries the 目录 / 搜索 segmented switch plus close; outline rows highlight by **page range** (last section at or before the current page) with a 第 X 页 tooltip hint.

### Inputs / Fields
- **Search:** compact 30px control with a hairline edge, search icon, query, and clear (×) — never a naked label or a SaaS-wide bar. Count, prev/next, and hits live only in the sidebar search mode. Sidebar results never scroll horizontally (`overflow-x: hidden`, wrapping snippets); the current hit gets a thin accent bar on a quiet wash, and hits are separated by hairlines, not cards.
- **Page index:** borderless text input, tabular nums, no spinner; hover/focus reveals the edge.

### Navigation
- Toolbar is the only global nav: 打开 (icon+label) / 目录 toggle (icon+label), history, page, zoom, search, settings. 目录 toggles the sidebar mode; the sidebar never repeats it as a tab.
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
- **Don't** put Chat chrome in the reader; translation stays 划词.
- **Don't** use text glyphs (← → − + ⚙ × ⌄) for toolbar chrome; the inline stroke sprite owns icons.
