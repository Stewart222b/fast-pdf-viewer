import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTranslationMessages,
} from "../web/js/translate-provider.js";
import {
  classifyTranslationMode,
  normalizePdfSelectionText,
  reflowLinesToParagraphs,
} from "../web/js/selection-text.js";

test("reflow joins PDF wrap lines and keeps paragraph breaks", () => {
  const lines = [
    "If the value for Start Radius of the wafer is 0 and the Secondary Inspection",
    "Region (SIR) is disabled, then the Primary Inspection Region is the region",
    "between the center of wafer and the Edge Exclusion Region (EER).",
    "When the SIR is enabled, the Primary Inspection Region is the region",
    "between the center of wafer and the Secondary Inspection Region (SIR).",
  ];
  const out = reflowLinesToParagraphs(lines);
  assert.equal(out.split("\n\n").length, 2);
  assert.match(out, /Region \(EER\)\.\n\nWhen the SIR/);
});

test("normalizePdfSelectionText handles hyphenation across wraps", () => {
  const raw = "secondary inspec-\ntion region";
  const out = normalizePdfSelectionText(raw);
  assert.equal(out, "secondary inspection region");
});

test("classifyTranslationMode routes short terms vs passages", () => {
  assert.equal(classifyTranslationMode("EER"), "term");
  assert.equal(classifyTranslationMode("edge exclusion"), "term");
  assert.equal(classifyTranslationMode("If the value is zero."), "passage");
  assert.equal(classifyTranslationMode("one two three four"), "passage");
});

test("buildTranslationMessages uses dictionary vs passage prompts", () => {
  const term = buildTranslationMessages("EER", "zh-CN", "term");
  assert.match(term[0].content, /dictionary/i);
  const passage = buildTranslationMessages("Para one.\n\nPara two.", "zh-CN", "passage");
  assert.match(passage[0].content, /coherent paragraphs/i);
  assert.doesNotMatch(passage[0].content, /line breaks/);
});
