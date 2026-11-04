import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentTools, documentToolDefinitions, TOOL_TEXT_LIMIT } from "../web/js/document-tools.js";

test("page and chapter reads provide exact continuation cursors", async () => {
  const long = "A".repeat(TOOL_TEXT_LIMIT + 400);
  const tools = createDocumentTools({ pageTexts: [{ pageNumber: 1, text: long }, { pageNumber: 2, text: "end" }, { pageNumber: 3, text: "next section" }],
    outlineEntries: [{ pageNumber: 1, depth: 0 }, { pageNumber: 2, depth: 1 }, { pageNumber: 3, depth: 0 }] });
  const first = await tools.execute("read_section", { startPage: 1 });
  assert.equal(first.pages[0].text.length, TOOL_TEXT_LIMIT);
  assert.equal(first.nextPage, 1);
  assert.equal(first.nextOffset, TOOL_TEXT_LIMIT);
  const rest = await tools.execute("read_section", { startPage: 1, page: first.nextPage, offset: first.nextOffset });
  assert.equal(first.pages[0].text + rest.pages[0].text, long);
  assert.equal(rest.pages[1].text, "end");
  assert.equal(rest.truncated, false);
  await assert.rejects(tools.execute("read_pages", { startPage: -1, endPage: 1000 }), /Invalid/);
  await assert.rejects(tools.execute("read_section", { startPage: 1, page: 3 }), /outside/);
});

test("full document search paginates and excludes unrelated ARC substrings", async () => {
  const pages = Array.from({ length: 25 }, (_, i) => ({ pageNumber: i + 1, text: `ARC coating ${i}` }));
  pages.push({ pageNumber: 26, text: "search searchable" });
  const tools = createDocumentTools({ pageTexts: pages });
  const first = await tools.execute("search_document", { query: "arc" });
  assert.equal(first.total, 25);
  assert.equal(first.hits.length, 20);
  const rest = await tools.execute("search_document", { query: "ARC", offset: first.nextOffset });
  assert.equal(rest.hits.length, 5);
  assert.equal(rest.nextOffset, null);
  assert.equal(tools.seenPages.has(26), false);
});

test("page images are opt-in, bounded and cancellable", async () => {
  assert.equal(documentToolDefinitions().some(row => row.function.name === "view_page"), false);
  const controller = new AbortController();
  const tools = createDocumentTools({ pageTexts: [], pageCount: 5, signal: controller.signal,
    readPageImage: async n => `data:image/jpeg;base64,page${n}` });
  assert.match((await tools.execute("view_page", { page: 1 })).image, /page1/);
  await tools.execute("view_page", { page: 2 });
  await tools.execute("view_page", { page: 3 });
  await assert.rejects(tools.execute("view_page", { page: 4 }), /budget/);
  controller.abort();
  await assert.rejects(tools.execute("search_document", { query: "ARC" }), { name: "AbortError" });
});
