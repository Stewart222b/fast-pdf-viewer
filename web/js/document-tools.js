import { searchDocument } from "./search.js";

export const TOOL_TEXT_LIMIT = 12_000;
export const TOOL_SEARCH_LIMIT = 20;

function tool(name, description, properties, required) {
  return { type: "function", function: { name, description,
    parameters: { type: "object", properties, required, additionalProperties: false } } };
}

export function documentToolDefinitions({ vision = false } = {}) {
  const tools = [
    tool("search_document", "Search ALL indexed PDF pages for a literal term or phrase. Try abbreviations, full names and alternate terms separately. Returns match windows with page numbers; use offset to retrieve more hits.",
      { query: { type: "string" }, offset: { type: "integer", minimum: 0 } }, ["query"]),
    tool("read_pages", "Read page text in an inclusive PDF page range. Returns nextPage/nextOffset when clipped; continue from there instead of assuming the rest is absent.",
      { startPage: { type: "integer", minimum: 1 }, endPage: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 } }, ["startPage", "endPage"]),
    tool("read_section", "Read a section by its outline start page, including child sections. Returns a continuation cursor for long sections.",
      { startPage: { type: "integer", minimum: 1 }, page: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 } }, ["startPage"]),
  ];
  if (vision) tools.push(tool("view_page", "View a PDF page as an image for diagrams, tables or scanned text. Only request pages relevant to the question.",
    { page: { type: "integer", minimum: 1 } }, ["page"]));
  return tools;
}

export function createDocumentTools({ pageTexts, outlineEntries = [], pageCount, readPageImage, onProgress, signal }) {
  const pages = pageTexts.filter(Boolean);
  const lastPage = pageCount || Math.max(0, ...pages.map(page => page.pageNumber));
  const seenPages = new Set();
  const searches = [];
  let textChars = 0;
  let imageCount = 0;

  function readPages(startPage, endPage, offset = 0) {
    if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage || endPage > lastPage
      || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid page range or text offset");
    const result = { pages: [], nextPage: null, nextOffset: 0, truncated: false };
    let remaining = Math.min(TOOL_TEXT_LIMIT, Math.max(0, 96_000 - textChars));
    for (let number = startPage; number <= endPage; number++) {
      const text = String(pages.find(page => page.pageNumber === number)?.text || "");
      const from = number === startPage ? offset : 0;
      if (from > text.length) throw new Error("Text offset is beyond the page");
      if (!remaining) {
        result.nextPage = number;
        result.truncated = true;
        break;
      }
      const body = text.slice(from, from + remaining);
      seenPages.add(number);
      result.pages.push({ pageNumber: number, text: body, offset: from });
      textChars += body.length;
      remaining -= body.length;
      if (from + body.length < text.length) {
        result.nextPage = number;
        result.nextOffset = from + body.length;
        result.truncated = true;
        break;
      }
      // Bound empty/scanned page ranges as well as text volume.
      if (result.pages.length >= 12 && number < endPage) {
        result.nextPage = number + 1;
        result.truncated = true;
        break;
      }
    }
    return result;
  }

  return {
    seenPages, searches,
    get textChars() { return textChars; },
    async execute(name, args = {}) {
      signal?.throwIfAborted();
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
      if (name === "search_document") {
        const query = String(args.query || "").trim();
        const offset = args.offset ?? 0;
        if (query.length < 2 || query.length > 200 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid search query or offset");
        if (textChars >= 96_000) throw new Error("Text budget reached; answer using existing evidence");
        const hits = searchDocument(pages, query, { wholeWord: /^[a-z0-9_-]+$/i.test(query) });
        const selected = hits.slice(offset, offset + TOOL_SEARCH_LIMIT).map(hit => {
          const page = pages.find(page => page.pageNumber === hit.pageNumber);
          // Search offsets are raw PDF text offsets; snippets are supplied by the index.
          seenPages.add(hit.pageNumber);
          return { pageNumber: page.pageNumber, snippet: hit.snippet };
        });
        searches.push({ query, total: hits.length });
        textChars += JSON.stringify(selected).length;
        onProgress?.({ type: "search", query, total: hits.length });
        return { query, total: hits.length, hits: selected,
          nextOffset: offset + selected.length < hits.length ? offset + selected.length : null };
      }
      if (name === "read_pages" || name === "read_section") {
        let start = args.startPage;
        let end = args.endPage;
        if (name === "read_section") {
          const index = outlineEntries.findIndex(row => row.pageNumber === start);
          if (index < 0) throw new Error("No outline section starts on this page; use read_pages");
          const entry = outlineEntries[index];
          end = outlineEntries.slice(index + 1).find(row => row.pageNumber > start && row.depth <= entry.depth)?.pageNumber - 1;
          if (!Number.isFinite(end)) end = lastPage;
          const cursorPage = args.page ?? start;
          if (cursorPage < start || cursorPage > end) throw new Error("Section cursor outside section");
          start = cursorPage;
        }
        const result = readPages(start, end, args.offset ?? 0);
        onProgress?.({ type: "read", start, end: result.pages.at(-1)?.pageNumber || start, truncated: result.truncated });
        return result;
      }
      if (name === "view_page" && readPageImage) {
        if (!Number.isInteger(args.page) || args.page < 1 || args.page > lastPage) throw new Error("Invalid image page");
        if (imageCount >= 3) throw new Error("Image budget reached; use page text instead");
        const image = await readPageImage(args.page, signal);
        signal?.throwIfAborted();
        imageCount++;
        seenPages.add(args.page);
        onProgress?.({ type: "image", page: args.page });
        return { pageNumber: args.page, image };
      }
      throw new Error("Unknown or unavailable document tool");
    },
  };
}
