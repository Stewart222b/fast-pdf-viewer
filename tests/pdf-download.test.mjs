import test from "node:test";
import assert from "node:assert/strict";
import { originalPdfBlob, pdfDownloadName, pdfSourceKind } from "../web/js/pdf-download.js";

test("source classification uses the original location rather than the MIME/worker Blob", () => {
  assert.equal(pdfSourceKind({ data: new Uint8Array(5), originalUrl: "https://arxiv.org/pdf/1706.03762", mimeStream: true }), "remote");
  assert.equal(pdfSourceKind({ url: "blob:extension/stream", originalUrl: "file:///C:/manual.pdf" }), "local");
  assert.equal(pdfSourceKind({ url: "blob:extension/file", sourceKind: "local" }), "local");
  assert.equal(pdfSourceKind({ path: "C:\\files\\manual.pdf", url: "/opened/abc.pdf" }), "local");
  assert.equal(pdfSourceKind({ path: "/home/user/manual.pdf", url: "/opened/abc.pdf" }), "local");
  assert.equal(pdfSourceKind({ path: "https://example.com/report.pdf", url: "blob:extension/stream" }), "remote");
  assert.equal(pdfSourceKind({ url: "blob:https://example.com/stream" }), "unknown");
  assert.equal(pdfSourceKind({ url: "/opened/abc.pdf" }), "unknown");
});

test("download filenames retain Unicode and PDF suffixes, and remove invalid path characters", () => {
  assert.equal(pdfDownloadName("中文手册.pdf"), "中文手册.pdf");
  assert.equal(pdfDownloadName("1706.03762"), "1706.03762.pdf");
  assert.equal(pdfDownloadName("REPORT.PDF"), "REPORT.PDF");
  assert.equal(pdfDownloadName("a/b\\c:report?.pdf"), "a_b_c_report_.pdf");
  assert.equal(pdfDownloadName("CON.pdf"), "_CON.pdf");
  assert.equal(pdfDownloadName("..."), "document.pdf");
});

test("retained original Blob is exported without asking PDF.js for another copy", async () => {
  const file = new Blob(["%PDF-original"], { type: "application/pdf" });
  const blob = await originalPdfBlob({ getData() { throw new Error("must not refetch"); } }, file);
  assert.equal(blob, file);
  assert.equal(await blob.text(), "%PDF-original");
});

test("remote PDFs retrieve complete original bytes from the active PDF.js document", async () => {
  let reads = 0;
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
  const blob = await originalPdfBlob({ async getData() { reads++; return bytes; } });
  assert.equal(reads, 1);
  assert.equal(blob.type, "application/pdf");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  await assert.rejects(originalPdfBlob({ async getData() { throw new Error("network unavailable"); } }), /network unavailable/);
});
