# Browser extension packaging

## Status

Implemented in this repository:

- `scripts/build-extension.mjs` builds the fixed `dist/browser-extension/` directory. It flattens `extension/` into the package root and copies the complete `web/` tree to `web/`.
- The builder verifies the pinned PDF.js `6.3.289` `VERSION`, `MANIFEST.json`, SHA-256 entries, modern and legacy modules, and the `cmaps/`, `standard_fonts/`, `wasm/`, and `iccs/` asset folders. For the extension staging tree only, it remaps `build/pdf.mjs`, `build/pdf.worker.mjs`, `web/pdf_viewer.css`, and `web/pdf_viewer.mjs` to the matching legacy files from the same pinned tarball. The PDF.js `MANIFEST.json` is used for build-time verification and omitted from the submitted package because Edge accepts only the extension’s root `manifest.json`. The repository’s normal `web/` tree remains modern.
- It requires the vendored PDF.js Apache `LICENSE`, copies the repository `LICENSE`, and adds `THIRD_PARTY_NOTICES/PDF.js-LICENSE`.
- The package is self-contained. The builder does not download PDF.js or any other runtime dependency. `python desktop/bootstrap_pdfjs.py` is only the source-preparation step when the vendored assets are absent; it is not used by the packaged extension.
- Replacement is staged and atomic. The fixed output is replaced only when its generated marker is recognized; an unmarked `dist/browser-extension/` is left untouched and causes a failure.
- `--zip` uses the system `zip` executable with argument-array spawning and writes `dist/browser-extension.zip`; when `zip` is unavailable (for example on Windows), it falls back to `tar -a` (bsdtar) with explicit top-level entries so entry names keep their layout.

Not performed or not verified by this task:

- No Chrome Web Store or Microsoft Edge Add-ons submission has been made. There is no store approval, listing, or policy-compliance claim.
- Chrome and Edge manual sideloading, remote PDF MIME handling, permission prompts, and translation flows still need a real-browser pass.
- Store-facing icon sizes, screenshots, listing text, privacy declarations, developer accounts, and review responses remain release work. The builder copies authored extension assets; it does not create missing icons.

## Build and inspect

From the repository root:

```sh
# Only needed if web/vendor/pdfjs is not already present and verified.
python3 desktop/bootstrap_pdfjs.py

node scripts/build-extension.mjs
node scripts/build-extension.mjs --zip
```

The unpacked package is `dist/browser-extension/`; the optional archive is `dist/browser-extension.zip`. The package must contain `manifest.json`, `background.js`, `options.html`, `web/index.html`, `LICENSE`, and the PDF.js assets under `web/vendor/pdfjs/`.

The packaged extension uses the legacy PDF.js build to avoid newer runtime APIs. Its compatibility target is Chrome/Edge **125–150**, with a minimum of **125** for this legacy package. Do not present the authored manifest’s older `minimum_chrome_version` value as a supported 102+ claim; update and verify that manifest value before release.

The focused packaging tests use small temporary fixtures, so they do not rebuild the repository’s full PDF.js tree repeatedly:

```sh
node --test tests/extension-package.test.mjs
```

CI also runs the full Node test command and the `--zip` build in `.github/workflows/extension.yml`.

## Privacy and data handling

The extension settings use the browser’s local extension storage. The configured API key is stored in `chrome.storage.local` and is not encrypted by this application; treat it as a credential available to the local browser profile and remove it when no longer needed.

For translation, only text the user selects in the PDF is sent to the configured provider, together with the request authentication and prompt needed for that provider. Model-list requests, when enabled, contact the configured provider but do not upload the PDF. PDF content is fetched in the browser from the remote PDF’s source host (or read from a local file in the normal web/desktop viewer); this packaging work does not send whole PDF files to the translation provider. Provider retention, logging, and training practices are outside this repository and must be checked before publication.

The extension requests `http://*/*` and `https://*/*` host access at install time so PDF routing and remote loading can work without per-site prompts. Optional `webRequest` is still requested only on browsers that need the legacy PDF interception path. Users can review and restrict site access in the browser’s extension settings.

## Chrome sideload checklist

This is a local test procedure, not a store publication.

1. Build the unpacked package with the commands above.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the `dist/browser-extension/` directory, not the repository’s `extension/` source directory.
4. Open the extension's options page. Confirm the setting is saved, the action opens `web/index.html`, and legacy browsers prompt for the optional `webRequest` permission before automatic opening is enabled.
5. Open a representative remote PDF and confirm the source-host request, original-document fallback, local PDF.js rendering, and selected-text translation behavior.
6. Reload the extension after each rebuild. Keep the DevTools console open for manifest, service-worker, MIME-handler, and permission errors.

Manual Chrome verification: **not performed here**.

## Edge sideload checklist

1. Build the same package; Edge uses the same unpacked directory.
2. Open `edge://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select `dist/browser-extension/`.
4. Repeat the options, permission, remote-PDF, fallback, rendering, and translation checks above.
5. Record Edge-specific manifest, MIME-handler, and permission differences before treating the result as release evidence.

Manual Edge verification: **not performed here**.

## Store publication checklist

Before submitting to either store, the owner should verify and record:

- [ ] A clean checkout has a verified vendored PDF.js tree and `node scripts/build-extension.mjs --zip` produces `dist/browser-extension.zip`.
- [ ] The manifest version, name, description, background service worker, options page, permissions, optional host permissions, and PDF handler behavior are final.
- [ ] All manifest-referenced icons exist at the declared sizes (`16`, `32`, `48`, and `128` where declared), plus any store artwork and screenshots.
- [ ] Chrome and Edge sideload checks pass on supported versions, including the permission-denied and network-error paths.
- [ ] The store privacy forms accurately disclose local unencrypted API-key storage, selected-text transmission to the user-chosen provider, remote PDF source-host fetching, optional host access, and any provider-side retention.
- [ ] Repository and PDF.js license/notice files are present in the submitted archive and any required attribution text is included in the listing or extension UI.
- [ ] Support URL, privacy-policy URL, contact details, release notes, and reviewer test instructions are ready.
- [ ] The Chrome Web Store upload and Edge Add-ons upload are each performed by an authorized publisher and their review outcomes are recorded.

Publication status: **no store submission has been done**.

## Other application targets

This packaging command writes only under `dist/`. It does not change the desktop Python server, the pywebview path, or the existing `web/` deployment. Desktop and ordinary web usage remain supported independently of the browser-extension package.
