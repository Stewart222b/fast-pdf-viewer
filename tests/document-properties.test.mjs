import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDocumentPropertyRows,
  formatFileSize,
  formatPageSize,
  formatPdfDate,
} from "../web/js/document-properties.js";

const t = (key, values = {}) => {
  const table = {
    fileSizeBytes: "{count} 字节",
    fileSizeKb: "{count} KB",
    fileSizeMb: "{count} MB",
    pageSizeValue: "{width} × {height} mm（{orientation}）",
    pagePortrait: "纵向",
    pageLandscape: "横向",
    yes: "是",
    no: "否",
    fileName: "文件名",
    fileSize: "文件大小",
    documentTitle: "标题",
    documentAuthor: "作者",
    documentSubject: "主题",
    documentKeywords: "关键字",
    documentCreationDate: "创建日期",
    documentModDate: "修改日期",
    documentCreator: "应用程序",
    documentProducer: "PDF 制作工具",
    pdfVersion: "PDF 版本",
    documentPageCount: "页数",
    pageSize: "页面大小",
    fastWebView: "快速网上查看",
    documentLocationPath: "位置",
  };
  return String(table[key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`);
};

test("formatFileSize uses bytes, KB, then MB", () => {
  assert.equal(formatFileSize(512, t), "512 字节");
  assert.equal(formatFileSize(2048, t), "2.0 KB");
  assert.equal(formatFileSize(2 * 1024 * 1024, t), "2.00 MB");
  assert.equal(formatFileSize(-1, t), "");
});

test("formatPdfDate reads PDF date strings", () => {
  assert.match(formatPdfDate("D:20200101120000Z", "en-US"), /2020/);
  assert.equal(formatPdfDate("", t), "");
});

test("formatPdfDate respects positive, negative, UTC and absent offsets", () => {
  for (const [pdfDate, date] of [
    ["D:20261104002632+08'00'", new Date('2026-11-04T00:26:32+08:00')],
    ["D:20261104002632-05'30'", new Date('2026-11-04T00:26:32-05:30')],
    ["D:20261104002632Z", new Date('2026-11-04T00:26:32Z')],
    ["D:20261104002632", new Date(2026, 10, 4, 0, 26, 32)],
    ["D:2026", new Date(2026, 0, 1)],
  ]) {
    assert.equal(formatPdfDate(pdfDate, 'zh-CN'), date.toLocaleString('zh-CN'), pdfDate);
  }
});

test("formatPageSize converts points to mm and orientation", () => {
  assert.equal(formatPageSize(612, 792, t), "215.9 × 279.4 mm（纵向）");
  assert.equal(formatPageSize(792, 612, t), "279.4 × 215.9 mm（横向）");
});

test("buildDocumentPropertyRows fills Edge-like fields and skips blob locations", () => {
  const rows = buildDocumentPropertyRows({
    fileName: "manual.pdf",
    fileSize: 2048,
    location: "blob:https://example/1",
    pageCount: 12,
    pageWidth: 612,
    pageHeight: 792,
    info: {
      Title: "Surfscan",
      Author: "KLA",
      PDFFormatVersion: "1.7",
      IsLinearized: true,
      CreationDate: "D:20200101120000Z",
    },
  }, t, "en-US");
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.fileName, "manual.pdf");
  assert.equal(byKey.fileSize, "2.0 KB");
  assert.equal(byKey.title, "Surfscan");
  assert.equal(byKey.author, "KLA");
  assert.equal(byKey.version, "1.7");
  assert.equal(byKey.linearized, "是");
  assert.equal(byKey.pageCount, "12");
  assert.equal(byKey.pageSize, "215.9 × 279.4 mm（纵向）");
  assert.equal(byKey.subject, "—");
  assert.equal(rows.some((row) => row.key === "location"), false);
});

test("http locations stay in the property list", () => {
  const rows = buildDocumentPropertyRows({
    fileName: "a.pdf",
    location: "https://example.com/a.pdf",
    info: {},
  }, t);
  assert.equal(rows.find((row) => row.key === "location")?.value, "https://example.com/a.pdf");
});
