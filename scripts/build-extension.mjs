import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Keep this contract in sync with desktop/bootstrap_pdfjs.py. The extension
// must package the already-vendored distribution; it never downloads at build
// or runtime.
export const PDFJS_VERSION = "6.3.289";
export const REQUIRED_PDFJS_FILES = [
  "LICENSE",
  "build/pdf.mjs",
  "build/pdf.worker.mjs",
  "web/pdf_viewer.css",
  "web/pdf_viewer.mjs",
];
export const REQUIRED_LEGACY_PDFJS_FILES = [
  "legacy/build/pdf.mjs",
  "legacy/build/pdf.worker.mjs",
  "legacy/web/pdf_viewer.css",
  "legacy/web/pdf_viewer.mjs",
];
export const LEGACY_PDFJS_REMAP = {
  "build/pdf.mjs": "legacy/build/pdf.mjs",
  "build/pdf.worker.mjs": "legacy/build/pdf.worker.mjs",
  "web/pdf_viewer.css": "legacy/web/pdf_viewer.css",
  "web/pdf_viewer.mjs": "legacy/web/pdf_viewer.mjs",
};
export const REQUIRED_PDFJS_FOLDERS = ["cmaps", "standard_fonts", "wasm", "iccs"];

export const BUILD_DIRECTORY = join("dist", "browser-extension");
export const ZIP_NAME = "browser-extension.zip";
export const GENERATED_MARKER_NAME = ".fast-pdf-viewer-browser-extension.generated";
export const GENERATED_MARKER =
  "fast-pdf-viewer browser-extension build output\n";
const ZIP_MARKER_NAME = ".fast-pdf-viewer-browser-extension.zip.generated";
const ZIP_MARKER = "fast-pdf-viewer browser-extension zip output\n";
const STAGING_PREFIX = ".browser-extension-staging-";
const BACKUP_PREFIX = ".browser-extension-backup-";
const ZIP_STAGING_PREFIX = ".browser-extension-zip-staging-";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isPathInside(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const childRelative = relative(parentPath, childPath);
  return childRelative === "" || (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !childRelative.startsWith(sep));
}

function assertFixedPath(path, root, label) {
  if (resolve(path) !== resolve(root, BUILD_DIRECTORY)) {
    throw new Error(`${label} must be the fixed ${BUILD_DIRECTORY} directory.`);
  }
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function requireDirectory(path, label) {
  const info = await pathInfo(path);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Browser-extension source is missing a real ${label} directory: ${path}`);
  }
}

async function requireRegularFile(path, label) {
  const info = await pathInfo(path);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Browser-extension source is missing a real ${label} file: ${path}`);
  }
}

function safeManifestPath(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name.split("/").includes("..")
  );
}

async function sha256(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Verify the vendored PDF.js layout and every digest recorded by the Python
 * bootstrap manifest. Returning the parsed manifest makes this useful to
 * callers without exposing an unverified asset list.
 */
export async function verifyPdfjsAssets(webDirectory) {
  const vendor = join(webDirectory, "vendor", "pdfjs");
  await requireDirectory(vendor, "web/vendor/pdfjs");
  await requireRegularFile(join(vendor, "VERSION"), "PDF.js VERSION");
  const version = (await readFile(join(vendor, "VERSION"), "utf8")).trim();
  if (version !== PDFJS_VERSION) {
    throw new Error(`Unsupported PDF.js version ${version || "(empty)"}; expected ${PDFJS_VERSION}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(vendor, "MANIFEST.json"), "utf8"));
  } catch (error) {
    throw new Error(`Invalid PDF.js MANIFEST.json: ${error.message}`);
  }
  if (!manifest || manifest.version !== PDFJS_VERSION || !manifest.files || Array.isArray(manifest.files)) {
    throw new Error(`PDF.js MANIFEST.json must describe version ${PDFJS_VERSION} and its files.`);
  }

  const entries = Object.entries(manifest.files);
  for (const [name, digest] of entries) {
    if (!safeManifestPath(name) || typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest)) {
      throw new Error(`PDF.js MANIFEST.json contains an unsafe or invalid file entry: ${name}`);
    }
    const file = resolve(vendor, ...name.split("/"));
    if (!isPathInside(vendor, file)) {
      throw new Error(`PDF.js MANIFEST.json escapes its vendor directory: ${name}`);
    }
    await requireRegularFile(file, `PDF.js asset ${name}`);
    if ((await sha256(file)).toLowerCase() !== digest.toLowerCase()) {
      throw new Error(`PDF.js asset checksum mismatch: ${name}`);
    }
  }

  for (const name of REQUIRED_PDFJS_FILES) {
    if (!Object.hasOwn(manifest.files, name)) {
      throw new Error(`PDF.js MANIFEST.json is missing required asset: ${name}`);
    }
    await requireRegularFile(join(vendor, ...name.split("/")), `PDF.js asset ${name}`);
  }
  for (const name of REQUIRED_LEGACY_PDFJS_FILES) {
    if (!Object.hasOwn(manifest.files, name)) {
      throw new Error(`PDF.js MANIFEST.json is missing required legacy asset: ${name}`);
    }
    await requireRegularFile(join(vendor, ...name.split("/")), `PDF.js asset ${name}`);
  }
  for (const folder of REQUIRED_PDFJS_FOLDERS) {
    const prefix = `${folder}/`;
    if (!entries.some(([name]) => name.startsWith(prefix))) {
      throw new Error(`PDF.js MANIFEST.json is missing required asset folder: ${folder}/`);
    }
  }
  return manifest;
}

async function readExtensionManifest(extensionDirectory) {
  const manifestPath = join(extensionDirectory, "manifest.json");
  await requireRegularFile(manifestPath, "extension/manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid extension/manifest.json: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("extension/manifest.json must contain a JSON object.");
  }
  const serviceWorker = manifest.background?.service_worker;
  if (serviceWorker !== "background.js") {
    throw new Error('extension/manifest.json must use root background.js as background.service_worker.');
  }
  const optionsPage = manifest.options_page ?? manifest.options_ui?.page;
  if (optionsPage !== "options.html") {
    throw new Error('extension/manifest.json must use root options.html as its options page.');
  }
  return manifest;
}

async function validateSources(root) {
  const webDirectory = join(root, "web");
  const extensionDirectory = join(root, "extension");
  await requireRegularFile(join(root, "LICENSE"), "repository LICENSE");
  await requireDirectory(webDirectory, "web");
  await requireDirectory(extensionDirectory, "extension");
  await requireRegularFile(join(webDirectory, "index.html"), "web/index.html");
  await requireRegularFile(join(extensionDirectory, "background.js"), "extension/background.js");
  await requireRegularFile(join(extensionDirectory, "options.html"), "extension/options.html");
  const manifest = await readExtensionManifest(extensionDirectory);
  await verifyPdfjsAssets(webDirectory);
  return { webDirectory, extensionDirectory, manifest };
}

async function copyEntry(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to package symbolic link: ${source}`);
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await copyEntry(join(source, entry.name), join(destination, entry.name));
    }
    return;
  }
  if (!info.isFile()) {
    throw new Error(`Refusing to package unsupported filesystem entry: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyDirectoryContents(source, destination) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    await copyEntry(join(source, entry.name), join(destination, entry.name));
  }
}

async function applyLegacyPdfjsRemap(staging, webDirectory) {
  const sourceVendor = join(webDirectory, "vendor", "pdfjs");
  const packagedVendor = join(staging, "web", "vendor", "pdfjs");
  for (const [destination, source] of Object.entries(LEGACY_PDFJS_REMAP)) {
    await copyFile(
      join(sourceVendor, ...source.split("/")),
      join(packagedVendor, ...destination.split("/")),
    );
  }
}

async function ensureDistDirectory(root) {
  const dist = join(root, "dist");
  const rootInfo = await pathInfo(root);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Project root is not a real directory: ${root}`);
  }
  const distInfo = await pathInfo(dist);
  if (distInfo && (!distInfo.isDirectory() || distInfo.isSymbolicLink())) {
    throw new Error(`Refusing to use a non-directory or symbolic-link dist path: ${dist}`);
  }
  await mkdir(dist, { recursive: true });
  return dist;
}

async function requireGeneratedMarker(directory) {
  const marker = join(directory, GENERATED_MARKER_NAME);
  await requireRegularFile(marker, "generated output marker");
  if ((await readFile(marker, "utf8")) !== GENERATED_MARKER) {
    throw new Error(`Refusing to replace ${directory}: generated output marker is not recognized.`);
  }
}

async function removeOwnedPath(path, parent, prefix) {
  if (dirname(path) !== resolve(parent) || !path.split(sep).pop().startsWith(prefix)) {
    throw new Error(`Refusing to remove an unscoped generated path: ${path}`);
  }
  await rm(path, { recursive: true, force: true });
}

async function replaceGeneratedDirectory(staging, output, root, dist) {
  assertFixedPath(output, root, "Output");
  if (!isPathInside(dist, output) || dirname(output) !== resolve(dist)) {
    throw new Error(`Output is outside the fixed dist directory: ${output}`);
  }
  await requireGeneratedMarker(staging);

  const existing = await pathInfo(output);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-directory browser-extension output: ${output}`);
    }
    await requireGeneratedMarker(output);
  }

  const backup = join(dist, `${BACKUP_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let movedExisting = false;
  try {
    if (existing) {
      await rename(output, backup);
      movedExisting = true;
    }
    await rename(staging, output);
  } catch (error) {
    if (movedExisting) {
      try {
        await rename(backup, output);
      } catch (restoreError) {
        error.message += ` Failed to restore the previous generated output: ${restoreError.message}`;
      }
    }
    throw error;
  }
  if (movedExisting) await removeOwnedPath(backup, dist, BACKUP_PREFIX);
}

function spawnWithStderr(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    // shell:false is intentional: paths are passed as individual arguments,
    // including paths containing spaces or shell metacharacters.
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`System ${command} failed${signal ? ` (${signal})` : ` with exit code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
    });
  });
}

async function looksLikeZipArchive(path) {
  const header = await readFile(path);
  if (header.length < 4) return false;
  return header[0] === 0x50 && header[1] === 0x4b;
}

async function createZipArchive(zipPath, outputDir) {
  try {
    // Prefer the system `zip` command for deterministic, CI-friendly archives.
    await spawnWithStderr("zip", ["-q", "-r", zipPath, "."], outputDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Fall back to tar only when it can emit a real ZIP (bsdtar). GNU tar's
    // `-a` follows the suffix but still writes a tar stream, not ZIP.
    const entries = (await readdir(outputDir)).sort((a, b) => a.localeCompare(b));
    const relativeZipPath = relative(outputDir, zipPath).replace(/\\/g, "/");
    try {
      await spawnWithStderr("tar", ["-a", "-c", "-f", relativeZipPath, ...entries], outputDir);
    } catch (tarError) {
      if (tarError.code === "ENOENT") {
        throw new Error("Cannot create the extension zip: neither system zip nor tar command was found.");
      }
      throw tarError;
    }
    if (!(await looksLikeZipArchive(zipPath))) {
      await rm(zipPath, { force: true });
      throw new Error(
        "Cannot create the extension zip: tar did not produce a ZIP archive. Install zip or bsdtar with ZIP support.",
      );
    }
  }
}

async function replaceGeneratedZip(stagingZip, zipPath, dist) {
  if (dirname(zipPath) !== resolve(dist) || !isPathInside(dist, zipPath)) {
    throw new Error(`Zip output is outside the fixed dist directory: ${zipPath}`);
  }
  const markerPath = join(dist, ZIP_MARKER_NAME);
  const existingZip = await pathInfo(zipPath);
  const existingMarker = await pathInfo(markerPath);
  if (existingZip) {
    if (!existingZip.isFile() || existingZip.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-file zip output: ${zipPath}`);
    }
    if (!existingMarker?.isFile() || existingMarker.isSymbolicLink() || (await readFile(markerPath, "utf8")) !== ZIP_MARKER) {
      throw new Error(`Refusing to replace ${zipPath}: its generated zip marker is missing or not recognized.`);
    }
  } else if (existingMarker) {
    if (!existingMarker.isFile() || existingMarker.isSymbolicLink() || (await readFile(markerPath, "utf8")) !== ZIP_MARKER) {
      throw new Error(`Refusing to remove an unrecognized zip marker: ${markerPath}`);
    }
  }

  const backupZip = join(dist, `${ZIP_STAGING_PREFIX}previous-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  const backupMarker = `${backupZip}.marker`;
  const markerStaging = `${stagingZip}.marker`;
  await writeFile(markerStaging, ZIP_MARKER, { flag: "wx" });
  let movedZip = false;
  let movedMarker = false;
  try {
    if (existingZip) {
      await rename(zipPath, backupZip);
      movedZip = true;
    }
    if (existingMarker) {
      await rename(markerPath, backupMarker);
      movedMarker = true;
    }
    await rename(stagingZip, zipPath);
    await rename(markerStaging, markerPath);
  } catch (error) {
    try {
      if (await pathInfo(zipPath)) await removeOwnedPath(zipPath, dist, ZIP_NAME);
    } catch {
      // Preserve the original failure; the path is still fixed and scoped.
    }
    if (movedZip) await rename(backupZip, zipPath);
    if (movedMarker) await rename(backupMarker, markerPath);
    throw error;
  }
  if (movedZip) await removeOwnedPath(backupZip, dist, ZIP_STAGING_PREFIX);
  if (movedMarker) await removeOwnedPath(backupMarker, dist, ZIP_STAGING_PREFIX);
}

async function createZip(output, root, dist) {
  const zipStage = await mkdtemp(join(dist, ZIP_STAGING_PREFIX));
  const stagingZip = join(zipStage, ZIP_NAME);
  try {
    await createZipArchive(stagingZip, output);
    await replaceGeneratedZip(stagingZip, join(dist, ZIP_NAME), dist);
    return join(dist, ZIP_NAME);
  } finally {
    await removeOwnedPath(zipStage, dist, ZIP_STAGING_PREFIX);
  }
}

/**
 * Build the unpacked browser extension, optionally creating a zip with the
 * system `zip` command. `root` is primarily exposed for isolated tests; the
 * CLI always uses the repository root and the fixed dist/browser-extension.
 */
export async function buildExtension({ root = SCRIPT_ROOT, zip = false } = {}) {
  const projectRoot = resolve(root);
  const output = join(projectRoot, BUILD_DIRECTORY);
  assertFixedPath(output, projectRoot, "Output");
  const sources = await validateSources(projectRoot);
  const dist = await ensureDistDirectory(projectRoot);
  const staging = await mkdtemp(join(dist, STAGING_PREFIX));
  try {
    await copyDirectoryContents(sources.webDirectory, join(staging, "web"));
    await applyLegacyPdfjsRemap(staging, sources.webDirectory);
    // MANIFEST.json is used to verify the vendored PDF.js files above, but it
    // must not be shipped: Edge treats it as a second extension manifest.
    await rm(join(staging, "web", "vendor", "pdfjs", "MANIFEST.json"), { force: true });
    await copyFile(join(projectRoot, "LICENSE"), join(staging, "LICENSE"));
    await mkdir(join(staging, "THIRD_PARTY_NOTICES"), { recursive: true });
    await copyFile(
      join(sources.webDirectory, "vendor", "pdfjs", "LICENSE"),
      join(staging, "THIRD_PARTY_NOTICES", "PDF.js-LICENSE"),
    );
    for (const entry of (await readdir(sources.extensionDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "web") {
        throw new Error("extension/web would collide with the packaged web/ directory; keep extension assets at the package root.");
      }
      await copyEntry(join(sources.extensionDirectory, entry.name), join(staging, entry.name));
    }
    await writeFile(join(staging, GENERATED_MARKER_NAME), GENERATED_MARKER, { flag: "wx" });
    await replaceGeneratedDirectory(staging, output, projectRoot, dist);
  } catch (error) {
    if (await pathInfo(staging)) await removeOwnedPath(staging, dist, STAGING_PREFIX);
    throw error;
  }

  const zipPath = zip ? await createZip(output, projectRoot, dist) : null;
  return { output, zip: zipPath };
}

function parseArguments(args) {
  let zip = false;
  for (const arg of args) {
    if (arg === "--zip") zip = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/build-extension.mjs [--zip]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { zip };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildExtension(parseArguments(process.argv.slice(2)));
    console.log(`Browser extension built at ${result.output}`);
    if (result.zip) console.log(`Browser extension zip written to ${result.zip}`);
  } catch (error) {
    console.error(`Browser extension build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
