import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTranslationMessages,
} from "../web/js/translate-provider.js";
import { MAX_TRANSLATE_CHARS } from "../web/js/translate-provider.js";
import {
  classifyTranslationMode,
  joinFragmentsWithSpanGaps,
  normalizePdfSelectionText,
  prepareSelectionForTranslation,
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

test("joinFragmentsWithSpanGaps inserts spaces between separated spans", () => {
  const out = joinFragmentsWithSpanGaps([
    { char: "h", left: 0, right: 8, top: 0, bottom: 10 },
    { char: "e", left: 8, right: 16, top: 0, bottom: 10 },
    { char: "l", left: 16, right: 24, top: 0, bottom: 10 },
    { char: "l", left: 24, right: 32, top: 0, bottom: 10 },
    { char: "o", left: 32, right: 40, top: 0, bottom: 10 },
    { char: "w", left: 52, right: 60, top: 0, bottom: 10 },
    { char: "o", left: 60, right: 68, top: 0, bottom: 10 },
    { char: "r", left: 68, right: 76, top: 0, bottom: 10 },
    { char: "l", left: 76, right: 84, top: 0, bottom: 10 },
    { char: "d", left: 84, right: 92, top: 0, bottom: 10 },
  ]);
  assert.equal(out, "hello world");
});

test("prepareSelectionForTranslation rejects raw length before geometry", () => {
  const long = "x".repeat(MAX_TRANSLATE_CHARS + 1);
  const prepared = prepareSelectionForTranslation({
    toString: () => long,
    rangeCount: 1,
    getRangeAt: () => ({}),
  });
  assert.equal(prepared.tooLong, true);
  assert.equal(prepared.text, "");
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
