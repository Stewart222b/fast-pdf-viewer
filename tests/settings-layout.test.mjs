import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const indexHtml = readFileSync(path.join(root, "web/index.html"), "utf8");
const mainJs = readFileSync(path.join(root, "web/js/main.js"), "utf8");
const stylesCss = readFileSync(path.join(root, "web/styles.css"), "utf8");

const modal = indexHtml.match(/<div id="settings-modal"[\s\S]*?\n {4}<\/div>/)?.[0] || "";
const cssBlock = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stylesCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] || "";
};
const attrs = (tag) => Object.fromEntries(
  [...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]),
);

const tabs = [...modal.matchAll(/<button[^>]*data-settings-tab="[^"]+"[^>]*>/g)].map(([tag]) => attrs(tag));
const panels = [...modal.matchAll(/<section[^>]*data-settings-panel="[^"]+"[^>]*>/g)]
  .map(([tag]) => ({ ...attrs(tag), hidden: /\shidden(?=[\s/>])/.test(tag) }));

test("the settings dialog exists with the three panes and their tabs", () => {
  assert.ok(modal, "settings modal markup is present");
  assert.equal(tabs.length, 3, "one rail tab per pane");
  assert.equal(panels.length, 3, "three panes");
  assert.deepEqual(
    tabs.map((tab) => tab["data-settings-tab"]),
    panels.map((panel) => panel["data-settings-panel"]),
    "tabs and panes are declared in the same order",
  );
});

test("each tab controls the pane it names and the aria state agrees", () => {
  for (const tab of tabs) {
    const key = tab["data-settings-tab"];
    const panel = panels.find((candidate) => candidate.id === tab["aria-controls"]);
    assert.ok(panel, `tab ${key} points at an existing pane`);
    assert.equal(panel["data-settings-panel"], key, `pane ${panel.id} matches the tab key`);
    assert.equal(panel.role, "tabpanel");
    assert.equal(panel["aria-labelledby"], tab.id, `pane ${panel.id} is labelled by its tab`);
    assert.equal(tab.role, "tab");
  }
  const open = panels.filter((panel) => !panel.hidden);
  assert.equal(open.length, 1, "exactly one pane is open initially");
  const selected = tabs.filter((tab) => tab["aria-selected"] === "true");
  assert.equal(selected.length, 1, "exactly one tab is selected initially");
  assert.equal(selected[0]["aria-controls"], open[0].id, "the selected tab owns the open pane");
  assert.equal(selected[0].tabindex, "0", "the selected tab is reachable with Tab");
  for (const tab of tabs.filter((candidate) => candidate["aria-selected"] !== "true")) {
    assert.equal(tab.tabindex, "-1", `inactive tab ${tab.id} is skipped by Tab`);
  }
});

test("every settings row has one label and one control on its right", () => {
  const chunks = modal.split('class="settings-row"').slice(1);
  assert.ok(chunks.length >= 9, "the panes carry the expected number of rows");
  for (const chunk of chunks) {
    const row = chunk.split('class="settings-row"')[0];
    assert.equal(row.match(/class="settings-row-label"/g)?.length, 1, "one label per row");
    assert.equal(row.match(/class="settings-row-control"/g)?.length, 1, "one control cell per row");
    assert.equal(row.match(/class="settings-row-text"/g)?.length, 1, "one text cell per row");
    assert.ok(
      row.indexOf('class="settings-row-text"') < row.indexOf('class="settings-row-control"'),
      "text comes before the control",
    );
  }
});

test("row labels point at a control inside the same row", () => {
  const chunks = modal.split('class="settings-row"').slice(1);
  for (const chunk of chunks) {
    const row = chunk.split('class="settings-row"')[0];
    const forId = row.match(/<label[^>]*class="settings-row-label"[^>]*for="([^"]+)"/)?.[1];
    if (!forId) continue;
    assert.ok(row.includes(`id="${forId}"`), `control ${forId} lives in its own row`);
    const control = row.match(new RegExp(`<(input|select|button)[^>]*id="${forId}"[^>]*>`))?.[0] || "";
    if (control.includes('type="checkbox"')) {
      assert.equal(
        attrs(control).role,
        "switch",
        `checkbox ${forId} announces itself as a switch`,
      );
      assert.ok(control.includes('class="switch"'), `checkbox ${forId} uses the switch style`);
    }
  }
});

test("the settings shell keeps one scroll area and a pinned commit row", () => {
  const card = cssBlock("#settings-modal .modal-card");
  assert.match(card, /display:\s*flex/);
  assert.match(card, /flex-direction:\s*column/);
  assert.match(card, /overflow:\s*hidden/, "the card never scrolls; the pane does");
  assert.match(
    card,
    /height:\s*min\(\d+px,\s*calc\(100dvh/,
    "one height for every pane, taken from the viewport instead of the content",
  );
  assert.doesNotMatch(card, /height:\s*auto/, "the panel must not size itself to the active pane");
  assert.doesNotMatch(card, /max-height:\s*min\([^;]*dvh/, "a content-capped height would resize on pane switch");

  assert.match(cssBlock(".settings-panes"), /overflow-y:\s*auto/);
  assert.match(cssBlock(".settings-row"), /display:\s*grid/);
  assert.match(cssBlock(".settings-row"), /grid-template-columns:[^;]*em/, "control column is fixed");
  assert.match(cssBlock("#settings-modal .modal-actions"), /justify-content:\s*flex-end|position:\s*static/);

  // The generic rule still pins the action row for the other dialogs.
  assert.match(cssBlock(".modal-actions"), /position:\s*sticky/);
  assert.match(cssBlock(".modal-actions"), /bottom:\s*0/);
});

test("the settings dialog drops the single-column section markup", () => {
  for (const legacy of ["settings-section", "setting-field", "setting-checkbox", "settings-advanced"]) {
    assert.ok(!modal.includes(legacy), `${legacy} markup is gone`);
    assert.ok(!stylesCss.includes(legacy), `${legacy} styles are gone`);
  }
});

test("pane switching is wired in main.js and survives a bare document", () => {
  assert.match(mainJs, /document\.querySelectorAll\?\.\(selector\)/);
  assert.match(mainJs, /\[data-settings-tab\]/);
  assert.match(mainJs, /\[data-settings-panel\]/);
  assert.match(mainJs, /pane\.hidden = pane\.dataset\.settingsPanel !== key/);
  assert.match(mainJs, /tab\.setAttribute\("aria-selected"/);
  assert.match(mainJs, /showSettingsPane\(settingsPane\)/, "the last pane is restored on open");
  assert.match(mainJs, /focusOpenSettingsPane\(\)/, "focus lands in the open pane");
});

test("the open pane is remembered but a blocked store cannot break the dialog", () => {
  assert.match(mainJs, /const SETTINGS_PANE_STORAGE_KEY = "fast-pdf-viewer-settings-pane"/);
  assert.match(mainJs, /globalThis\.localStorage\?\.getItem\?\./, "reading tolerates a bare document");
  assert.match(mainJs, /globalThis\.localStorage\?\.setItem\?\./, "writing tolerates a blocked store");
  assert.match(mainJs, /let settingsPane = readStoredSettingsPane\(\) \|\|/, "a stored pane wins over the default");
  assert.match(mainJs, /storeSettingsPane\(key\)/, "every switch persists the pane");
});
