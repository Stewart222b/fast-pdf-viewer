import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GENERATED_MARKER_NAME,
  buildExtension,
} from "../scripts/build-extension.mjs";

const execFileAsync = promisify(execFile);

function archiveNames(stdout) {
  return stdout
    .trim()
    .split(/\r?\n/)
    .map(name => name.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
}

async function looksLikeZipArchive(archive) {
  const header = await readFile(archive);
  if (header.length < 4) return false;
  return header[0] === 0x50 && header[1] === 0x4b;
}

async function listArchiveNames(archive) {
  if (!(await looksLikeZipArchive(archive))) {
    throw new Error(`Archive is not a ZIP file: ${archive}`);
  }
  const attempts = [
    ["unzip", ["-Z1", archive]],
    ["zipinfo", ["-1", archive]],
  ];
  let lastError = null;
  for (const [command, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(command, args);
      return archiveNames(stdout);
    } catch (error) {
      lastError = error;
      if (error.code !== "ENOENT" && error.code !== 1 && error.code !== 9) throw error;
    }
  }
  throw lastError ?? new Error("No ZIP listing tool is available.");
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "fast-pdf-viewer-extension-"));
  const pdfjs = join(root, "web", "vendor", "pdfjs");
  const extension = join(root, "extension");
  await mkdir(join(root, "web"), { recursive: true });
  await mkdir(extension, { recursive: true });

  await writeFile(join(root, "LICENSE"), "Fast PDF Viewer license\n");
  await writeFile(join(root, "web", "index.html"), "<!doctype html><title>fixture</title>\n");
  await writeFile(join(root, "extension", "background.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  await writeFile(join(root, "extension", "options.html"), "<!doctype html><title>options</title>\n");
  await writeFile(
    join(root, "extension", "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Fixture",
      version: "0.0.1",
      background: { service_worker: "background.js" },
      options_page: "options.html",
    }),
  );

  const pdfjsFiles = {
    LICENSE: "Apache License 2.0 fixture\n",
    "build/pdf.mjs": "export const fixture = true;\n",
    "build/pdf.worker.mjs": "export const worker = true;\n",
    "web/pdf_viewer.css": ".fixture {}\n",
    "web/pdf_viewer.mjs": "export const viewer = true;\n",
    "legacy/build/pdf.mjs": "export const legacy = 'pdf';\n",
    "legacy/build/pdf.worker.mjs": "export const legacy = 'worker';\n",
    "legacy/web/pdf_viewer.css": ".legacy {}\n",
    "legacy/web/pdf_viewer.mjs": "export const legacy = 'viewer';\n",
    "cmaps/fixture.bcmap": "cmap\n",
    "standard_fonts/fixture.pfb": "font\n",
    "wasm/fixture.wasm": "wasm\n",
    "iccs/fixture.icc": "icc\n",
  };
  const hashes = {};
  for (const [name, contents] of Object.entries(pdfjsFiles)) {
    const path = join(pdfjs, ...name.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
    hashes[name] = createHash("sha256").update(contents).digest("hex");
  }
  await writeFile(join(pdfjs, "VERSION"), "6.3.289\n");
  await writeFile(join(pdfjs, "MANIFEST.json"), JSON.stringify({ version: "6.3.289", files: hashes }));
  return root;
}

async function withFixture(callback) {
  const root = await createFixture();
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("builds a browser-loadable package with local PDF.js and legal files", async () => {
  await withFixture(async root => {
    const result = await buildExtension({ root });
    const output = result.output;

    assert.equal(result.zip, null);
    assert.equal(await readFile(join(output, "LICENSE"), "utf8"), "Fast PDF Viewer license\n");
    assert.equal(
      await readFile(join(output, "THIRD_PARTY_NOTICES", "PDF.js-LICENSE"), "utf8"),
      "Apache License 2.0 fixture\n",
    );
    assert.equal(await readFile(join(output, "manifest.json"), "utf8").then(JSON.parse).then(m => m.background.service_worker), "background.js");
    assert.equal(await readFile(join(output, "web", "index.html"), "utf8"), "<!doctype html><title>fixture</title>\n");
    const packagedVendor = join(output, "web", "vendor", "pdfjs");
    assert.equal(await readFile(join(packagedVendor, "build", "pdf.mjs"), "utf8"), "export const legacy = 'pdf';\n");
    assert.equal(await readFile(join(packagedVendor, "build", "pdf.worker.mjs"), "utf8"), "export const legacy = 'worker';\n");
    assert.equal(await readFile(join(packagedVendor, "web", "pdf_viewer.css"), "utf8"), ".legacy {}\n");
    assert.equal(await readFile(join(packagedVendor, "web", "pdf_viewer.mjs"), "utf8"), "export const legacy = 'viewer';\n");
    const packagedManifest = JSON.parse(await readFile(join(packagedVendor, "MANIFEST.json"), "utf8"));
    assert.equal(
      packagedManifest.files["build/pdf.mjs"],
      createHash("sha256").update("export const legacy = 'pdf';\n").digest("hex"),
    );
    assert.equal(await readFile(join(output, GENERATED_MARKER_NAME), "utf8"), "fast-pdf-viewer browser-extension build output\n");
  });
});

test("rejects incomplete PDF.js before creating a package", async () => {
  await withFixture(async root => {
    await rm(join(root, "web", "vendor", "pdfjs", "build", "pdf.worker.mjs"));
    await assert.rejects(
      buildExtension({ root }),
      /missing a real PDF\.js asset build\/pdf\.worker\.mjs file/,
    );
    assert.deepEqual(await readdir(join(root, "dist")).catch(() => []), []);
  });
});

test("does not replace an unmarked fixed output directory", async () => {
  await withFixture(async root => {
    const output = join(root, "dist", "browser-extension");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "do-not-delete.txt"), "user data\n");

    await assert.rejects(buildExtension({ root }), /generated output marker/);
    assert.equal(await readFile(join(output, "do-not-delete.txt"), "utf8"), "user data\n");
  });
});

test("optional zip contains the package and both license files", async () => {
  await withFixture(async root => {
    const result = await buildExtension({ root, zip: true });
    assert.ok(result.zip);
    const names = await listArchiveNames(result.zip);
    assert.ok(names.includes("LICENSE"));
    assert.ok(names.includes("THIRD_PARTY_NOTICES/PDF.js-LICENSE"));
    assert.ok(names.includes("web/index.html"));
    assert.ok(names.includes("manifest.json"));
    assert.ok(!names.some(name => name.startsWith("./")), "zip entries must not start with ./");
  });
});

test("rejects GNU tar output that is not a ZIP archive", async () => {
  await withFixture(async root => {
    const originalPath = process.env.PATH;
    const tarOnlyPath = await mkdtemp(join(tmpdir(), "fast-pdf-viewer-tar-only-path-"));
    await symlink("/usr/bin/tar", join(tarOnlyPath, "tar"));
    process.env.PATH = tarOnlyPath;
    try {
      await assert.rejects(
        buildExtension({ root, zip: true }),
        /tar did not produce a ZIP archive/,
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(tarOnlyPath, { recursive: true, force: true });
    }
  });
});

test("rejects with a clear error when neither zip nor tar is available", async () => {
  await withFixture(async root => {
    const originalPath = process.env.PATH;
    const emptyDir = await mkdtemp(join(tmpdir(), "fast-pdf-viewer-empty-path-"));
    process.env.PATH = emptyDir;
    try {
      await assert.rejects(
        buildExtension({ root, zip: true }),
        /neither system zip nor tar command was found/,
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
