# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are engineers and other people who read English-language PDFs for work—especially long technical manuals—and need translation that works as soon as they select text, without setting up a chat product.

The first real user is Larry: hours in documents like semiconductor/tool manuals (hundreds of pages), needing a reader that opens fast, scrolls continuously, can return after outline/search jumps, and translates in place.

GitHub is public for the same kind of reader. Design and defaults serve that reading job first.

## Product Purpose

Fast PDF Viewer – AI Translation is a lightweight PDF **reader**. Success is: open quickly, scroll smoothly, jump and get back, find text, and translate a selection in an English technical document without leaving the page.

It exists because Edge/Chrome PDF preview is slow on large files, weak at returning to the previous reading position, and does not offer 划词 translation.

## Positioning

A fast, minimal technical-document reader with browser-style navigation and instant 划词 AI translation. Not Acrobat. Not a PDF toolbox. Translation is selection-to-translation, not Chat.

The combination that neighboring products cannot copy as a single claim: on-demand pdf.js reading (IntersectionObserver, ~8-page cache) plus OpenAI-compatible 划词 translation in the same local viewer.

## Operating Context

- Local files on the user’s machine; PDFs are not uploaded.
- Desktop: Python + pywebview (or `--browser` in Edge/Chrome) serving localhost.
- Web adapter / GitHub Pages is optional and must not fork a second viewer.
- Typical documents: long English manuals (e.g. tool user guides of several hundred pages).
- Translation uses a user-supplied API key in reader settings (OpenAI-compatible; default OpenRouter).
- Official distribution: GitHub.

## Capabilities and Constraints

**In scope:** fast open, continuous scroll, zoom (fit width / fit page / percent), full-text search with hit counts, PDF outline, back/forward history, restore reading position, 划词 AI translation (auto-translate on select, optional 译 chip, streaming, term vs passage), compact UI.

**Out of scope:** edit, convert to Word, signatures, cloud sync, accounts, AI Chat, RAG, large-scale annotation, PWA, browser extension (unless later explicitly requested).

**Technical constraints to preserve:**
- Keep `web/js/viewer.js` architecture (IntersectionObserver, on-demand render, page cache). Do not rewrite it as React/Vite/official Viewer.
- Keep Python localhost + Range; do not switch the stack to Node for unification.
- Translation stays OpenAI-compatible (Base URL / Key / Model / language), not a chat UI.
- Reader Core stays shared; Desktop and Web are adapters, not two viewers.

**Undecided (visual only, not product truth):** UI visual world. A redesign is planned on `feat/ui-redesign`; no DESIGN.md yet.

## Brand Commitments

- Name: **Fast PDF Viewer – AI Translation**.
- UI language: Chinese, with industry terms kept in English (PDF, API, worker, PR, 划词).
- No additional logo, legal, or brand-asset lock was confirmed.

## Evidence on Hand

- README product copy and feature table.
- `docs/media/hero-reading.png` (illustrative reading UI; not a user testimonial).
- Local large-manual reading (e.g. SP7-class PDFs) as the evaluation ritual.
- No customer quotes, press, or fabricated benchmarks. Future design must not invent testimonials, customers, or performance numbers.

## Product Principles

1. Reading first: every chrome decision should keep the page and the selection job faster, not add a toolbox.
2. Instant translation at the pointer: 划词 is a core reading action, not a chat sidebar.
3. Stay where you were: outline, search, and history must return the reader without losing place.
4. Ship as a local reader: files stay on disk; GitHub is the entry; adapters must not split the viewer.
5. Preserve the proven render loop: do not trade smoothness for a framework rewrite.
