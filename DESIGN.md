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
  signal-blue-strong: "#5b8cff"
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
    fontSize: "14px"
    fontWeight: 600
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
    rounded: "{rounded.lg}"
    padding: "8px 12px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.signal-blue-strong}"
    textColor: "{colors.primary-on-accent}"
  button-ghost:
    backgroundColor: "{colors.night-shell}"
    textColor: "{colors.readout}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.hover-plate}"
    textColor: "{colors.readout}"
  input-search:
    backgroundColor: "{colors.night-shell}"
    textColor: "{colors.readout}"
    rounded: "{rounded.lg}"
    padding: "4px 6px 4px 10px"
  chip-translate:
    backgroundColor: "{colors.chip-well}"
    textColor: "{colors.readout}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 8px"
  card-bubble:
    backgroundColor: "{colors.bubble-well}"
    textColor: "{colors.readout}"
    rounded: "{rounded.xl}"
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
- **信号蓝** (`{colors.signal-blue}`): focus, active outline, checked zoom item, chip hover. Stronger fill (`{colors.signal-blue-strong}`) is the primary button (打开).

### Neutral
- **夜壳** (`{colors.night-shell}`): app ground and ghost-button fill.
- **抬升面** (`{colors.raised-deck}`): toolbar and menus sitting one step above the ground.
- **悬停板** (`{colors.hover-plate}`): hover/active non-primary controls.
- **目录井** (`{colors.sidebar-well}`): outline/search sidebar (slightly off the ground, not a tokenized CSS variable).
- **发丝线** (`{colors.hairline}`): borders and menu-item hover wash.
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
- **Title** (600, 14px): toolbar document title.
- **Body** (400, 14px, inherit): chrome labels, outline rows, bubble copy.
- **Label** (400, 12px): search hit counts and compact meta.

### Named Rules
**The One Family Rule.** Do not introduce Inter, a second display face, or icon fonts for chrome. The PDF text layer uses pdf.js faces, not this stack.

## Layout

Top **toolbar** is 56px, grid of left / fluid center title / right tools, 14px horizontal padding, 8–12px control gaps. Below it, a **flex workspace**: 300px outline/search sidebar (slides as a fixed-width inner pane) plus `#viewer-wrap` which owns remaining width and recenters the page. Page stack gap is 18px. Sidebar close must collapse to zero flex width so no gutter remains.

## Elevation & Depth

Flat at rest. Structure is darker vs slightly-lighter fills plus 1px hairlines. The shared shadow (`0 12px 40px rgba(0, 0, 0, 0.35)`) appears only on floating chrome: zoom menu, translate bubble, 译 chip, modal.

### Shadow Vocabulary
- **浮层** (`box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35)`): menus, bubble, chip, modal. Do not stack extra shadows.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat until they float over the page.

## Shapes

Controls are softly rounded: 10px on toolbar buttons and search field, 8px on compact chips and outline rows, 12px on the translate bubble, 6px on zoom-menu rows. The PDF page and the viewer canvas stay sharp rectangles.

## Components

### Buttons
- **Shape:** 10px corners, 36px tall, 8×12 padding, 1px hairline.
- **Primary:** 信号蓝强底、白字、无描边；hover 提高亮度。
- **Ghost:** 夜壳底 + 发丝线；hover 悬停板；active 非主按钮描边改信号蓝。
- **Disabled:** 40% opacity.

### Chips
- **译 chip:** 28px tall, 8px radius, `#2a3140` fill, shared 浮层 shadow; hover uses 信号蓝 on border and type.

### Cards / Containers
- **Translate bubble:** 12px radius, `#222733`, 10px pad, max 420px, shared shadow, internal scroll.
- **Modal:** raised deck, 16px radius, same shadow.
- **Sidebar:** 300px, `#161922`, hairline right edge; inner pane translates, width does not squeeze type.

### Inputs / Fields
- **Search:** hairline capsule on 夜壳, transparent inner field, no extra focus ring beyond the box.
- **Page index:** text input, tabular nums, no spinner.

### Navigation
- Toolbar is the only global nav: 打开 / 目录, history, page, zoom, search, settings. 目录 is an active ghost, not a second primary. Sidebar tabs sit inside the well.

### Signature: 划词气泡
Fixed overlay anchored to the selection focus end, clamped inside `#viewer-wrap`. Compact chrome; streaming caret while tokens arrive.

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
