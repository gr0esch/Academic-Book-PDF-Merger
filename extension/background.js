// Background service worker: job queue for parallel PDF merge operations.
importScripts("lib/pdf-lib.min.js", "lib/fflate.min.js");

// --- Job queue ---
// Each job = one book merge. Jobs run concurrently (one per tab).
const jobs = new Map(); // jobId -> job state
let jobCounter = 0;

function createJob(tabId, bookTitle) {
  const id = ++jobCounter;
  const job = {
    id,
    tabId,
    bookTitle,
    phase: "queued", // queued | working | done | error
    progress: 0,
    totalSteps: 0,
    statusText: "Queued...",
    logs: [],
    errorMsg: "",
    startedAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function jobLog(job, text, cls) {
  job.logs.push({ text, cls });
}

function jobProgress(job, text) {
  job.progress++;
  job.statusText = text;
}

// --- Utilities ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ±30% jitter so successive requests don't form an obvious periodic pattern.
function sleepWithJitter(ms) {
  const jitter = 0.7 + Math.random() * 0.6;
  return sleep(Math.round(ms * jitter));
}

// CDN / origin codes that indicate "try again later", not a permanent failure.
const RETRIABLE_STATUSES = new Set([429, 502, 503, 504]);

function isRetriable(result) {
  return !!(result && result.status && RETRIABLE_STATUSES.has(result.status));
}

// Retry an async producer up to N times on retriable HTTP statuses, with
// exponential backoff (2s, 4s, …). Logs retry intent into the job feed.
async function withRetry(job, fn, { attempts = 3, baseDelayMs = 2000 } = {}) {
  let result;
  for (let i = 0; i < attempts; i++) {
    result = await fn();
    if (!isRetriable(result)) return result;
    if (i < attempts - 1) {
      const wait = baseDelayMs * Math.pow(2, i);
      jobLog(
        job,
        `  HTTP ${result.status} — retrying in ${Math.round(wait / 1000)}s (attempt ${i + 2}/${attempts})`,
        "log-warn"
      );
      await sleep(wait);
    }
  }
  return result;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function toBase64(bytes) {
  let binary = "";
  const cs = 32768;
  for (let i = 0; i < bytes.length; i += cs) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + cs));
  }
  return btoa(binary);
}

async function runInMainWorld(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args: args || [],
  });
  if (results && results[0]) return results[0].result;
  return null;
}

// --- Offscreen helpers ---

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Create blob URL for PDF download",
  });
}

function createBlobUrlViaOffscreen(base64Data) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: "createBlobUrl", base64: base64Data },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.url) {
          resolve(response.url);
        } else {
          reject(new Error(response?.error || "No blob URL returned"));
        }
      }
    );
  });
}

// --- Injected into MAIN world: fetch chapter page, extract PDF link ---
// Accepts selectors and/or a meta-tag name so each publisher can specify its own.

async function _pageFetchPdfUrl(chapterUrl, primarySelector, fallbackSelector, metaName) {
  try {
    const resp = await fetch(chapterUrl, { credentials: "same-origin" });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const html = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    if (metaName) {
      // citation_pdf_url meta tag — CUP exposes the PDF URL here even when not logged in
      const meta = doc.querySelector(`meta[name='${metaName}'], meta[name='${metaName} ']`);
      if (meta) {
        const content = (meta.getAttribute("content") || "").trim();
        if (content) {
          return {
            url: content.startsWith("http") ? content : new URL(content, chapterUrl).href,
          };
        }
      }
    }

    const selectors = [primarySelector, fallbackSelector].filter(Boolean);
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const href = el.getAttribute("href");
        return {
          url: href.startsWith("http") ? href : new URL(href, chapterUrl).href,
        };
      }
    }
    return { error: "No PDF link on page" };
  } catch (e) {
    return { error: `${e.name}: ${e.message}` };
  }
}

// --- Injected into MAIN world: fetch a binary URL using the page's session ---
// Runs in the user's already-authenticated tab, so SameSite=Lax/Strict cookies
// ride along (the extension context cannot replicate this).

async function _pageFetchBinary(url, expectedTypeSubstrings) {
  try {
    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) return { error: `HTTP ${resp.status}`, status: resp.status, finalUrl: resp.url };
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (Array.isArray(expectedTypeSubstrings) && expectedTypeSubstrings.length > 0) {
      const match = expectedTypeSubstrings.some((t) => ct.includes(t));
      if (!match) {
        return {
          error: `Wrong content-type: ${ct || "unknown"}`,
          contentType: ct,
          finalUrl: resp.url,
        };
      }
    }
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Body-shape validation: when we expect a PDF, the file MUST start with %PDF-.
    // CUP's "view" endpoint returns Content-Type: application/pdf but the body is
    // actually an HTML viewer page, so the content-type check alone is not enough.
    const wantPdf =
      Array.isArray(expectedTypeSubstrings) && expectedTypeSubstrings.includes("pdf");
    if (wantPdf && bytes.length >= 5) {
      const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
      if (head !== "%PDF-") {
        // Return a printable preview of the leading bytes so we can diagnose what
        // CUP is actually serving (HTML wrapper, login page, etc.).
        const previewLen = Math.min(300, bytes.length);
        let preview = "";
        for (let i = 0; i < previewLen; i++) {
          const c = bytes[i];
          preview += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
        }
        return {
          error: `Not a PDF (starts with ${JSON.stringify(head)}, size=${bytes.length})`,
          contentType: ct,
          finalUrl: resp.url,
          preview,
        };
      }
    }

    let binary = "";
    const cs = 32768;
    for (let i = 0; i < bytes.length; i += cs) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + cs));
    }
    return { base64: btoa(binary), size: bytes.length, contentType: ct };
  } catch (e) {
    return { error: `${e.name}: ${e.message}` };
  }
}

// --- Download PDF via hidden tab (browser-native request with cookies) ---

async function downloadPdfViaTab(pdfUrl) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(
      { url: pdfUrl, active: false, pinned: true },
      (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const tabId = tab.id;
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            chrome.tabs.remove(tabId).catch(() => {});
            reject(new Error("Tab load timeout (90s)"));
          }
        }, 90000);

        function onUpdated(updatedTabId, changeInfo) {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearTimeout(timeout);

          setTimeout(async () => {
            try {
              const results = await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: async () => {
                  try {
                    const resp = await fetch(window.location.href, {
                      credentials: "same-origin",
                    });
                    if (!resp.ok) return { error: `HTTP ${resp.status}` };
                    const buffer = await resp.arrayBuffer();
                    const bytes = new Uint8Array(buffer);
                    let binary = "";
                    const cs = 32768;
                    for (let i = 0; i < bytes.length; i += cs) {
                      binary += String.fromCharCode.apply(
                        null,
                        bytes.subarray(i, i + cs)
                      );
                    }
                    return { base64: btoa(binary), size: bytes.length };
                  } catch (e) {
                    return { error: `In-tab fetch: ${e.message}` };
                  }
                },
              });
              chrome.tabs.remove(tabId).catch(() => {});
              resolved = true;
              if (results?.[0]?.result) {
                resolve(results[0].result);
              } else {
                reject(new Error("No result from tab script"));
              }
            } catch (err) {
              chrome.tabs.remove(tabId).catch(() => {});
              resolved = true;
              reject(err);
            }
          }, 1000);
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
      }
    );
  });
}

// --- Per-chapter scrape + download path ---

async function fetchPerChapter(job, chapters, settings, providerInfo) {
  const pdfSelector = providerInfo?.pdfLinkSelector || "a.article-pdfLink[href*='.pdf']";
  const pdfFallback = providerInfo?.pdfLinkFallback || "a[href*='chapter-ag-pdf']";
  const pdfMetaName = providerInfo?.pdfMetaName || "";
  // CUP serves PDFs with SameSite-restricted cookies, so we must fetch from the page
  // context. OUP works fine with the hidden-tab method, so keep that as default.
  const usePageFetch = providerInfo?.fetchMethod === "page";

  // Step 1: Find PDF URLs
  const pdfEntries = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const label = ch.number ? `Ch. ${ch.number}: ${ch.title}` : ch.title;
    jobProgress(job, `Finding PDF ${i + 1}/${chapters.length}: ${label}`);

    const result = await withRetry(job, () =>
      runInMainWorld(job.tabId, _pageFetchPdfUrl, [
        ch.href,
        pdfSelector,
        pdfFallback,
        pdfMetaName,
      ])
    );
    if (isRetriable(result)) {
      throw new Error(
        `Rate-limited by server (HTTP ${result.status}). Try again in a few minutes, or bump "Request delay" in Settings.`
      );
    }
    if (result?.url) {
      pdfEntries.push({ url: result.url, label });
      jobLog(job, `Found: ${label}`, "log-ok");
    } else {
      jobLog(job, `No PDF: ${label} (${result?.error || "?"})`, "log-warn");
    }
    if (i < chapters.length - 1) await sleepWithJitter(settings.delayMs || 500);
  }

  if (pdfEntries.length === 0) throw new Error("No PDF links found.");

  // Step 2: Download PDFs via hidden tabs
  const pdfBase64List = [];
  for (let i = 0; i < pdfEntries.length; i++) {
    const { url, label } = pdfEntries[i];
    jobProgress(job, `Downloading ${i + 1}/${pdfEntries.length}: ${label}`);

    try {
      const result = usePageFetch
        ? await withRetry(job, () =>
            runInMainWorld(job.tabId, _pageFetchBinary, [url, ["pdf"]])
          )
        : await downloadPdfViaTab(url);
      if (isRetriable(result)) {
        throw new Error(
          `Rate-limited by server (HTTP ${result.status}). Try again in a few minutes, or bump "Request delay" in Settings.`
        );
      }
      if (result?.base64) {
        pdfBase64List.push(result.base64);
        jobLog(job, `Downloaded: ${label} (${formatBytes(result.size)})`, "log-ok");
      } else {
        const looksLikePaywall =
          result?.finalUrl && /\/core\/books\/abs\//i.test(result.finalUrl);
        if (looksLikePaywall) {
          jobLog(
            job,
            `Failed: ${label} — no access (CUP redirected to abstract page)`,
            "log-error"
          );
        } else {
          jobLog(job, `Failed: ${label} (${result?.error || "no data"})`, "log-error");
        }
        if (result?.finalUrl && result.finalUrl !== url) {
          jobLog(job, `  redirected to: ${result.finalUrl}`, "log-warn");
        }
        if (result?.preview) {
          jobLog(job, `  body starts: ${result.preview.slice(0, 120)}`, "log-warn");
        }
      }
    } catch (err) {
      jobLog(job, `Failed: ${label} (${err.message})`, "log-error");
    }
    if (i < pdfEntries.length - 1) await sleepWithJitter(settings.delayMs || 500);
  }

  return pdfBase64List;
}

// --- CUP ZIP path: one GET, unzip in service worker ---

async function fetchZipBundle(job, chapters, providerInfo) {
  const ids = chapters.map((c) => c.id).filter(Boolean).join(",");
  if (!ids) throw new Error("No chapter IDs for ZIP request.");
  const zipUrl = providerInfo.zipUrlTemplate.replace("{IDS}", ids);

  jobProgress(job, `Fetching ZIP bundle (${chapters.length} chapters)...`);
  jobLog(job, `Requesting ZIP from ${new URL(zipUrl).host}...`, "");

  // Run inside the user's authenticated tab so SameSite cookies are sent.
  const result = await withRetry(job, () =>
    runInMainWorld(job.tabId, _pageFetchBinary, [zipUrl, ["zip"]])
  );
  if (!result) throw new Error("No response from page fetch");
  if (isRetriable(result)) {
    throw new Error(
      `Rate-limited by server (HTTP ${result.status}). Try again in a few minutes, or bump "Request delay" in Settings.`
    );
  }
  if (result.error) throw new Error(result.error);
  if (!result.base64) throw new Error("ZIP response had no body");

  const binary = atob(result.base64);
  const zipBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) zipBytes[i] = binary.charCodeAt(i);
  jobLog(job, `Downloaded ZIP: ${formatBytes(zipBytes.length)}`, "log-ok");

  jobProgress(job, "Extracting ZIP...");
  const entries = fflate.unzipSync(zipBytes, {
    filter: (file) => /\.pdf$/i.test(file.name),
  });
  // Natural sort: c1 < c2 < c10, p28 < p100. CUP filenames look like
  // "9780511921766c2_p28-72_CBO.pdf" — chapter prefix order matches TOC order.
  const names = Object.keys(entries).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  if (names.length === 0) throw new Error("ZIP contained no PDFs.");
  jobLog(job, `Extracted ${names.length} PDFs from ZIP`, "log-ok");

  return names.map((n) => toBase64(entries[n]));
}

// --- Run a single merge job ---

async function runJob(job, chapters, settings, providerInfo) {
  job.phase = "working";
  const provider = providerInfo?.provider || "oup";
  const canTryZip = provider === "cup" && providerInfo?.zipUrlTemplate;
  job.totalSteps = canTryZip ? 3 : chapters.length * 2 + 1;

  try {
    let pdfBase64List = [];

    if (canTryZip) {
      try {
        pdfBase64List = await fetchZipBundle(job, chapters, providerInfo);
      } catch (zipErr) {
        jobLog(job, `ZIP failed: ${zipErr.message} — falling back to per-chapter`, "log-warn");
        job.totalSteps = chapters.length * 2 + 1;
        job.progress = 0;
        pdfBase64List = await fetchPerChapter(job, chapters, settings, providerInfo);
      }
    } else {
      pdfBase64List = await fetchPerChapter(job, chapters, settings, providerInfo);
    }

    if (pdfBase64List.length === 0) throw new Error("No PDFs downloaded.");

    // Step 3: Merge
    jobProgress(job, "Merging PDFs...");
    jobLog(job, `Merging ${pdfBase64List.length} PDFs...`, "");

    const { PDFDocument } = PDFLib;
    const mergedPdf = await PDFDocument.create();

    for (let k = 0; k < pdfBase64List.length; k++) {
      try {
        const binary = atob(pdfBase64List[k]);
        const bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
        const doc = await PDFDocument.load(bytes.buffer, { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(doc, doc.getPageIndices());
        pages.forEach((page) => mergedPdf.addPage(page));
        jobLog(job, `  Merged #${k + 1}: ${doc.getPageCount()} pages`, "");
      } catch (err) {
        jobLog(job, `  Skip #${k + 1}: ${err.message}`, "log-warn");
      }
    }

    if (mergedPdf.getPageCount() === 0) throw new Error("Merge produced 0 pages.");

    const mergedBytes = await mergedPdf.save();
    jobLog(job, `Total: ${mergedPdf.getPageCount()} pages, ${formatBytes(mergedBytes.length)}`, "log-ok");

    // Step 4: Save via offscreen blob URL
    const b64 = toBase64(mergedBytes);
    const sanitizedTitle = job.bookTitle.replace(/[<>:"/\\|?*]/g, "").trim();
    const filename = settings.downloadFolder
      ? `${settings.downloadFolder}/${sanitizedTitle}.pdf`
      : `${sanitizedTitle}.pdf`;

    await ensureOffscreen();
    const blobUrl = await createBlobUrlViaOffscreen(b64);

    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: blobUrl, filename, saveAs: false },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            jobLog(job, `Saved: ${filename}`, "log-ok");
            resolve();
          }
        }
      );
    });

    job.phase = "done";
    jobLog(job, "Complete!", "log-ok");
  } catch (err) {
    job.phase = "error";
    job.errorMsg = err.message;
    jobLog(job, `Error: ${err.message}`, "log-error");
  }

  // Close offscreen if no other jobs are running
  const runningJobs = [...jobs.values()].filter((j) => j.phase === "working");
  if (runningJobs.length === 0) {
    chrome.offscreen.closeDocument().catch(() => {});
  }
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "startMerge") {
    const job = createJob(message.tabId, message.bookTitle);
    // Start immediately (runs concurrently with other jobs)
    runJob(job, message.chapters, message.settings, message.providerInfo);
    sendResponse({ ok: true, jobId: job.id });
    return false;
  }

  if (message.action === "getJobs") {
    // Return all jobs, newest first
    const allJobs = [...jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((j) => ({
        id: j.id,
        bookTitle: j.bookTitle,
        phase: j.phase,
        progress: j.progress,
        totalSteps: j.totalSteps,
        statusText: j.statusText,
        logs: j.logs,
        errorMsg: j.errorMsg,
      }));
    sendResponse({ jobs: allJobs });
    return false;
  }

  if (message.action === "clearJob") {
    jobs.delete(message.jobId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === "clearDone") {
    for (const [id, job] of jobs) {
      if (job.phase === "done" || job.phase === "error") jobs.delete(id);
    }
    sendResponse({ ok: true });
    return false;
  }
});
