#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(PROJECT_DIR, "image-prompt.json");
const LOG_PATH = path.join(PROJECT_DIR, "generator.log");
const PROFILE_DIR = path.join(PROJECT_DIR, "browser-profile");
const GENERATED_DIR = path.join(PROJECT_DIR, "generated");
const UPSCALED_DIR = path.join(PROJECT_DIR, "upscaled");
const CHROME_CHANNEL = process.env.META_AI_BROWSER_CHANNEL || "chrome";
const LANDSCAPE_PREFIX = "Landscape 16:9 wide orientation for all images. ";

const args = process.argv.slice(2);
const selectedBatches = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
const checkOnly = args.includes("--check");
const dryRun = args.includes("--dry-run");
const loginOnly = args.includes("--login");
const upscaleOnly = args.includes("--upscale-only");

const ui = {
  activeLabel: "",
  lastActivity: Date.now(),
  stream: process.stdout,
  workers: new Map(),
  completed: 0,
  total: 0,
};

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

async function writeLog(message) {
  await fs.appendFile(LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf8").catch(() => {});
}

function updateStatus(label, force = false) {
  if (!ui.stream.isTTY) return;
  if (!force && label === ui.activeLabel && Date.now() - ui.lastActivity < 100) return;
  ui.activeLabel = label;
  ui.lastActivity = Date.now();
  ui.stream.write(`\r\x1b[2K${label}`.slice(0, process.columns - 2 || 120));
}

function clearStatus() {
  if (ui.stream.isTTY) ui.stream.write("\r\x1b[2K");
}

async function say(message, kind = "info") {
  await writeLog(message);
  if (ui.stream.isTTY) clearStatus();
  const marks = { info: "•", success: "✓", warning: "!", error: "×" };
  const colors = { info: 36, success: 32, warning: 33, error: 31 };
  console.log(`${color(marks[kind], colors[kind])} ${message}`);
}

async function status(label) {
  await writeLog(label);
  updateStatus(`⏳ ${label}`);
}

function progressBar(current, total, width = 12) {
  const ratio = Math.max(0, Math.min(1, total ? current / total : 0));
  const filled = Math.round(ratio * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${String(current).padStart(String(total).length, " ")}/${total} ${Math.round(ratio * 100)}%`;
}

function setWorkerStatus(workerId, label) {
  if (label === null) ui.workers.delete(workerId);
  else ui.workers.set(workerId, label);

  const details = [...ui.workers.values()];
  ui.activeLabel = "";
  if (details.length) {
    updateStatus(`⏳ Upscale ${progressBar(ui.completed || 0, ui.total || 0)} | ${details.join(" | ")}`);
  }
}

function shortUpscaleName(fileName) {
  const match = fileName.match(/^batch-(\d+)-(\d+)-/);
  return match ? `${match[1]}-${match[2]}` : fileName.replace(/\.jpe?g$/i, "");
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("") + "-" + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("-");
}


async function readConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

function buildPrompt(config, batch) {
  const text = batch.prompt.trim();
  const needsLandscape = config.landscape !== false && !text.slice(0, 60).toLowerCase().includes("landscape");
  return needsLandscape ? `${LANDSCAPE_PREFIX}${text}` : text;
}

async function ensureProjectFolders(config) {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.mkdir(UPSCALED_DIR, { recursive: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  if (config.outputDir) {
    await fs.mkdir(path.resolve(PROJECT_DIR, config.outputDir), { recursive: true });
  }
}

function isFileJpeg(filePath) {
  const head = Buffer.alloc(3);
  const descriptor = fsSync.openSync(filePath, "r");
  try {
    fsSync.readSync(descriptor, head, 0, head.length, 0);
  } finally {
    fsSync.closeSync(descriptor);
  }
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

function sniffImage(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

async function detectBrowserExecutable() {
  const candidates = process.platform === "win32" ? [
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Google/Chrome/Application/chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  ].filter(Boolean) : [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    process.env.HOME && path.join(process.env.HOME, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }

  return null;
}

async function convertToJpeg(inputPath, outputPath, quality = 92) {
  let sharpError;
  try {
    const sharpModule = await import("sharp");
    await sharpModule.default(inputPath).jpeg({ quality }).toFile(outputPath);
    return;
  } catch (error) {
    sharpError = error;
  }

  for (const command of ["magick", "convert"]) {
    const executable = fsSync.existsSync(command) ? command : null;
    const fallback = executable || [
      process.platform === "win32" ? path.join(process.env["ProgramFiles"] || "", "ImageMagick", "magick.exe") : "/opt/homebrew/bin/magick",
      process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "", "ImageMagick", "convert.exe") : "/usr/local/bin/convert",
    ].find((candidate) => candidate && fsSync.existsSync(candidate));
    if (!fallback) continue;
    const child = await import("node:child_process");
    const result = child.spawnSync(fallback, [inputPath, "-quality", String(quality), outputPath], { stdio: "pipe" });
    if (result.status === 0 && fsSync.existsSync(outputPath) && fsSync.statSync(outputPath).size > 0) return;
  }

  throw new Error(`Gagal konversi ke JPEG (${sharpError?.message || "sharp tidak tersedia"}). Jalankan: npm install sharp`);
}

async function convertBytesToJpeg(bytes, outputPath, quality = 92) {
  const sharpModule = await import("sharp");
  await sharpModule.default(bytes).jpeg({ quality }).toFile(outputPath);
}

async function launchMetaAi(config) {
  const { chromium } = await import("playwright");
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: CHROME_CHANNEL,
      headless: false,
      viewport: null,
      acceptDownloads: true,
      timeout: 30000,
    });
  } catch (error) {
    const executablePath = await detectBrowserExecutable();
    if (!executablePath) {
      throw new Error("Google Chrome tidak ditemukan. Install Chrome, atau set META_AI_BROWSER_CHANNEL=msedge bila pakai Edge.");
    }
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath,
      headless: false,
      viewport: null,
      acceptDownloads: true,
      timeout: 30000,
    });
  }

  const page = context.pages()[0] || await context.newPage();
  const currentUrl = page.url();
  if (!/meta\.ai/.test(currentUrl)) {
    await page.goto("https://meta.ai", { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  return { context, page };
}

async function fillPrompt(page, prompt) {
  await page.waitForFunction(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return [...document.querySelectorAll('textarea,[contenteditable="true"]')].some(visible);
  }, undefined, { timeout: 20000, polling: 500 });

  const composer = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textareas = [...document.querySelectorAll("textarea")].filter(visible);
    if (textareas.length) return { kind: "textarea" };
    const editables = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
    return editables.length ? { kind: "contenteditable" } : null;
  });

  if (!composer) {
    throw new Error("Composer Meta AI tidak ditemukan. Kemungkinan belum login. Jalankan 'node generator.mjs --login' dulu.");
  }

  const selector = composer.kind === "textarea" ? "textarea" : '[contenteditable="true"]';
  await page.click(selector).catch(() => {});
  await page.waitForTimeout(300);

  const textLength = () => page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const element = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible)[0];
    if (!element) return -1;
    return element.isContentEditable ? (element.textContent || "").length : (element.value || "").length;
  });

  let length = -1;
  await page.keyboard.insertText(prompt).catch(async () => {
    await page.keyboard.type(prompt);
  });
  await page.waitForTimeout(400);
  length = await textLength();

  if (length < 20) {
    await page.keyboard.type(prompt);
    await page.waitForTimeout(400);
    length = await textLength();
  }

  if (length < 20) {
    await page.evaluate((text) => {
      const element = [...document.querySelectorAll('textarea,[contenteditable="true"]')][0];
      if (!element) return;
      element.focus();
      if (element.isContentEditable) {
        element.textContent = text;
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
      } else {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(element, text);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, prompt);
    await page.waitForTimeout(400);
    length = await textLength();
  }

  if (length < 20) {
    throw new Error(`Gagal memasukkan prompt ke Meta AI (terisi ${length} karakter).`);
  }
}

async function submitPrompt(page) {
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);

  const stopVisible = () => page.evaluate(() =>
    [...document.querySelectorAll("button")].some((button) =>
      /stop/i.test(button.getAttribute("aria-label") || "")
    )
  );

  let started = await stopVisible();
  if (!started) {
    await page.waitForTimeout(5000);
    started = await stopVisible();
  }

  if (!started) {
    await page.evaluate(() => {
      const candidate = [...document.querySelectorAll("button")].find((button) =>
        /submit|send|kirim/i.test(button.getAttribute("aria-label") || "") || button.type === "submit"
      );
      candidate?.click();
    });
    await page.waitForTimeout(4000);
    started = await stopVisible();
  }

  if (!started) {
    const remaining = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const element = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible)[0];
      return element ? (element.isContentEditable ? element.textContent.length : element.value.length) : 0;
    });
    if (remaining > 5) {
      throw new Error("Prompt tidak terkirim: indikator generasi tidak muncul dan composer masih berisi.");
    }
  }
}

async function waitForGeneratedImages(page, baseline, expectedCount, timeoutSeconds) {
  try {
    await page.waitForFunction(({ base, need }) => {
      const images = [...document.querySelectorAll('img[src*="scontent"]')];
      const ready = images.filter((image) => image.complete && image.naturalWidth >= 200);
      const generating = [...document.querySelectorAll("button")].some((button) =>
        /stop/i.test(button.getAttribute("aria-label") || "")
      );
      return !generating && ready.length >= base + need;
    }, { base: baseline, need: expectedCount }, { timeout: timeoutSeconds * 1000, polling: 1500 });
  } catch {
    throw new Error(`Timeout menunggu ${expectedCount} gambar selesai (${timeoutSeconds} detik).`);
  }

  return page.evaluate(() =>
    [...document.querySelectorAll('img[src*="scontent"]')]
      .filter((image) => image.complete && image.naturalWidth >= 200)
      .map((image) => image.currentSrc || image.src)
  );
}

async function runBatch(config, batchIndex, batch, browser) {
  const name = batch.name || `batch-${String(batchIndex).padStart(2, "0")}`;
  const prompt = buildPrompt(config, batch);
  const outputDir = path.resolve(PROJECT_DIR, config.outputDir || config.output_dir || "generated");
  const expectedCount = Number(config.imagesPerPrompt || config.images_per_prompt || 4);
  const stamp = timestamp();
  const producedFiles = [];
  const startedAt = Date.now();

  await writeLog(`=== BATCH ${batchIndex}: ${name} ===`);
  await writeLog(`Prompt: ${prompt}`);
  await status(`Generate ${name} — ${progressBar(0, expectedCount)}`);

  try {
    const { context, page } = browser;
    const baseline = await page.evaluate(() =>
      [...document.querySelectorAll('img[src*="scontent"]')].length
    );

    await fillPrompt(page, prompt);
    await submitPrompt(page);
    await status(`Generate ${name} — ${progressBar(0, expectedCount)} — waiting images`);
    const imageUrls = await waitForGeneratedImages(
      page,
      baseline,
      expectedCount,
      Number(config.timeoutSeconds || config.timeout_seconds || 300),
    );

    const latestUrls = imageUrls.slice(-expectedCount);
    if (latestUrls.length < expectedCount) {
      throw new Error(`Hanya ada ${latestUrls.length} gambar siap, butuh ${expectedCount}.`);
    }

    let failedCount = 0;
    for (let index = 0; index < expectedCount; index += 1) {
      const finalOutputName = `${name}-${index + 1}-${stamp}.jpg`;
      const finalOutputPath = path.join(outputDir, finalOutputName);
      const downloadAttempts = 3;
      let downloadError = null;
      let converted = false;

      for (let attempt = 1; attempt <= downloadAttempts; attempt += 1) {
        try {
          const response = await context.request.get(latestUrls[index], { timeout: 60000 });
          if (!response.ok()) {
            throw new Error(`HTTP ${response.status()}`);
          }
          const bytes = Buffer.from(await response.body());
          const imageType = sniffImage(bytes);
          if (!imageType) {
            throw new Error(`format ${bytes.subarray(0, 12).toString("hex")} tidak dikenali`);
          }
          if (imageType === "jpeg") {
            await fs.writeFile(finalOutputPath, bytes);
          } else {
            await convertBytesToJpeg(bytes, finalOutputPath);
          }
          converted = true;
          await writeLog(`OK ${finalOutputName} from ${imageType}${attempt > 1 ? ` attempt ${attempt}` : ""}`);
          break;
        } catch (error) {
          downloadError = error;
          await writeLog(`WARN ${finalOutputName} download/konversi gagal attempt ${attempt}/${downloadAttempts}: ${error.message}`);
          if (attempt < downloadAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
      }

      if (!converted) {
        failedCount += 1;
        await say(`${name} gambar ${index + 1} gagal — ${downloadError?.message || "unknown error"}`, "error");
        await fs.rm(finalOutputPath, { force: true }).catch(() => {});
        continue;
      }

      producedFiles.push(finalOutputPath);
      await status(`Generate ${name} — ${progressBar(index + 1, expectedCount)} — saving JPEG`);
    }

    if (failedCount) {
      throw new Error(`${failedCount} dari ${expectedCount} gambar gagal download/konversi.`);
    }

    const duration = Math.round((Date.now() - startedAt) / 1000);
    await say(`${name} — ${producedFiles.length} gambar JPG — ${duration}s`, "success");
    await writeLog(`BATCH ${name} SELESAI: ${producedFiles.length} gambar`);
    return { ok: true, files: producedFiles };
  } catch (error) {
    await say(`${name} gagal — ${error.message}`, "error");
    await writeLog(`BATCH ${name} GAGAL: ${error.message}`);
    return { ok: false, files: producedFiles };
  }
}

async function upscaleFile(filePath, upscaleConfig) {
  const fileName = path.basename(filePath);
  const extension = upscaleConfig.outputFormat || "jpg";
  const outputPath = path.join(UPSCALED_DIR, `${path.basename(fileName, path.extname(fileName))}_upscaled_${upscaleConfig.scale}x.${extension}`);

  const uploadPath = filePath;
  const uploadName = fileName;
  const mimeType = /\.(png)$/i.test(fileName) ? "image/png" : "image/jpeg";

  const formData = new FormData();
  formData.append("myfile", new File([await fs.readFile(uploadPath)], uploadName, { type: mimeType }), uploadName);
  formData.append("scaleRadio", String(upscaleConfig.scale));

  const headers = {
    Origin: "https://imgupscaler.com",
    Referer: "https://imgupscaler.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  };

  const uploadResponse = await fetch(upscaleConfig.uploadUrl, { method: "POST", body: formData, headers });
  const upload = await uploadResponse.json();
  const taskId = upload?.data?.code;
  if (upload?.code !== 200 || !taskId) {
    throw new Error(`Upload gagal: ${JSON.stringify(upload)}`);
  }

  let status = "waiting";
  let downloadUrl = "";
  const onStatus = upscaleConfig.onStatus || (() => {});
  for (let poll = 1; poll <= upscaleConfig.maxPolls; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, upscaleConfig.pollIntervalSeconds * 1000));
    onStatus(`poll ${poll}/${upscaleConfig.maxPolls}`);
    await writeLog(`UPSCALER ${uploadName} poll ${poll}`);
    const response = await fetch(upscaleConfig.statusUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ code: taskId, scaleRadio: upscaleConfig.scale }),
    });
    const payload = await response.json();
    if (payload?.code !== 200) continue;
    status = payload?.data?.status || status;
    if (status === "success") {
      downloadUrl = payload?.data?.downloadUrls?.[0] || "";
      break;
    }
  }

  if (status !== "success" || !downloadUrl) {
    throw new Error(`Upscale gagal atau timeout (status: ${status}).`);
  }

  const imageResponse = await fetch(downloadUrl);
  if (!imageResponse.ok) {
    throw new Error(`Download hasil upscale gagal: HTTP ${imageResponse.status}`);
  }
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (!bytes.length) {
    throw new Error("Download hasil upscale kosong.");
  }
  await fs.writeFile(outputPath, bytes);
  return outputPath;
}

async function upscaleFiles(files, config) {
  const upscaleConfig = {
    scale: Number(config.scale || 4),
    pollIntervalSeconds: Number(config.pollIntervalSeconds || 10),
    maxPolls: Number(config.maxPolls || 10),
    uploadUrl: config.uploadUrl || "https://get1.imglarger.com/api/UpscalerNew/UploadNew",
    statusUrl: config.statusUrl || "https://get1.imglarger.com/api/UpscalerNew/CheckStatusNew",
    outputFormat: config.outputFormat || "jpg",
  };
  const concurrency = Math.max(1, Number(config.concurrency || 2));
  const maxAttempts = Math.max(1, Number(config.retryAttempts || 3));
  const uploadDelaySeconds = Math.max(0, Number(config.uploadDelaySeconds ?? 3));
  const pending = [...files];
  const outputFiles = [];
  let failures = 0;
  let completed = 0;
  const startedAt = Date.now();
  ui.completed = 0;
  ui.total = files.length;

  await writeLog(`=== UPSCALE === File: ${pending.length} Scale: ${upscaleConfig.scale}x`);
  await say(`Upscale ${files.length} gambar — scale ${upscaleConfig.scale}x — concurrency ${concurrency}`);

  async function worker() {
    const workerId = Symbol("worker");
    let lastShortName = "";
    while (pending.length) {
      const filePath = pending.shift();
      if (pending.length) {
        await new Promise((resolve) => setTimeout(resolve, uploadDelaySeconds * 1000));
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          lastShortName = shortUpscaleName(path.basename(filePath));
          setWorkerStatus(workerId, lastShortName);
          const outputPath = await upscaleFile(filePath, {
            ...upscaleConfig,
            onStatus: (label) => setWorkerStatus(workerId, `${lastShortName} ${label}`),
          });
          outputFiles.push(outputPath);
          await fs.unlink(filePath);
          completed += 1;
          ui.completed = completed;
          setWorkerStatus(workerId, null);
          await writeLog(`SUCCESS ${path.basename(filePath)} -> ${path.basename(outputPath)}`);
          break;
        } catch (error) {
          if (attempt === maxAttempts) {
            failures += 1;
            completed += 1;
            ui.completed = completed;
            setWorkerStatus(workerId, null);
            await say(`${path.basename(filePath)} gagal — ${error.message}`, "error");
            await writeLog(`ERROR ${path.basename(filePath)} ${error.message}`);
          } else {
            const delaySeconds = Math.min(60, uploadDelaySeconds * 2 ** attempt);
            setWorkerStatus(workerId, `${lastShortName} retry ${delaySeconds}s`);
            await writeLog(`RETRY ${path.basename(filePath)} ${error.message} delay ${delaySeconds}s`);
            await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
          }
        }
      }
    }
    setWorkerStatus(workerId, null);
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, worker));
  const duration = Math.round((Date.now() - startedAt) / 1000);
  await say(`Upscale selesai — sukses ${outputFiles.length}, gagal ${failures}, ${duration}s`, failures ? "warning" : "success");
  return failures === 0;
}

async function upscaleExisting(config) {
  const outputDir = path.resolve(PROJECT_DIR, config.outputDir || config.output_dir || "generated");
  const files = (await fs.readdir(outputDir))
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
    .map((name) => path.join(outputDir, name));

  if (!files.length) {
    await say(`Tidak ada gambar untuk upscale di ${outputDir}.`, "warning");
    return false;
  }
  return upscaleFiles(files, config.upscale || {});
}

async function checkLogin() {
  await status("Cek login Meta AI...");
  const { context, page } = await launchMetaAi({});
  try {
    await page.waitForFunction(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return [...document.querySelectorAll('textarea,[contenteditable="true"]')].some(visible);
    }, undefined, { timeout: 20000, polling: 500 });
    await say("Meta AI siap. Sudah login dan composer terlihat.", "success");
    return true;
  } catch {
    await say("Composer tidak ditemukan. Login Meta AI di browser yang terbuka, lalu jalankan --check lagi.", "error");
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}

async function openForLogin() {
  await say("Buka Chrome project. Login Meta AI, lalu tutup browser setelah selesai.", "info");
  const { context } = await launchMetaAi({});
  context.on("close", () => writeLog("Browser profile ditutup. Login disimpan di browser-profile/."));
  await new Promise(() => {});
}

async function main() {
  if (dryRun) {
    const config = await readConfig();
    const batches = config.batches || [];
    console.log(color("=== RENCANA ===", 36));
    batches.forEach((batch, index) => {
      console.log(`Batch ${index + 1}: ${batch.name || `batch-${index + 1}`}`);
      console.log(`  ${buildPrompt(config, batch).slice(0, 110)}...`);
    });
    console.log(`Output : ${path.resolve(PROJECT_DIR, config.outputDir || config.output_dir || "generated")}`);
    console.log(`Upscale: ${config.upscale?.enabled !== false ? "aktif" : "nonaktif"}`);
    return;
  }

  const config = await readConfig();
  const batches = config.batches || [];
  await ensureProjectFolders(config);

  if (checkOnly) process.exit(await checkLogin() ? 0 : 1);
  if (loginOnly) {
    await openForLogin();
    return;
  }
  if (upscaleOnly) {
    process.exit(await upscaleExisting(config) ? 0 : 1);
  }

  if (!batches.length) {
    console.error("ERROR: image-prompt.json tidak punya 'batches'.");
    process.exit(1);
  }

  const choices = selectedBatches.length
    ? selectedBatches.filter((index) => index >= 1 && index <= batches.length)
    : batches.map((_, index) => index + 1);

  if (!choices.length) {
    console.error(`ERROR: nomor batch di luar jangkauan 1-${batches.length}.`);
    process.exit(1);
  }

  const generatedFiles = [];
  const results = {};
  const generateStartedAt = Date.now();
  await say(`Generate ${choices.length} batch`, "info");
  const browser = await launchMetaAi(config);
  try {
    for (const batchIndex of choices) {
      const result = await runBatch(config, batchIndex, batches[batchIndex - 1], browser);
      results[batchIndex] = result.ok;
      generatedFiles.push(...result.files);
    }
  } finally {
    await browser.context.close().catch(() => {});
  }

  const generateDuration = Math.round((Date.now() - generateStartedAt) / 1000);
  const successCount = Object.values(results).filter(Boolean).length;
  const failedCount = choices.length - successCount;
  await say(`Generate selesai — sukses ${successCount}, gagal ${failedCount}, ${generateDuration}s`, failedCount ? "warning" : "success");

  for (const batchIndex of choices) {
    const name = batches[batchIndex - 1].name || `batch-${batchIndex}`;
    await writeLog(`RINGKASAN Batch ${batchIndex} ${name}: ${results[batchIndex] ? "SUKSES" : "GAGAL"}`);
  }

  const shouldUpscale = config.upscale?.enabled !== false;
  if (shouldUpscale && generatedFiles.length) {
    await upscaleFiles(generatedFiles, config.upscale || {});
  }
}

main().catch(async (error) => {
  await say(`ERROR: ${error.message}`, "error");
  process.exitCode = 1;
});
