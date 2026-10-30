(function () {
  "use strict";

  const $bookTitle = document.getElementById("bookTitle");
  const $notBookPage = document.getElementById("notBookPage");
  const $chapterList = document.getElementById("chapterList");
  const $chapters = document.getElementById("chapters");
  const $selectAll = document.getElementById("selectAll");
  const $deselectAll = document.getElementById("deselectAll");
  const $selectedCount = document.getElementById("selectedCount");
  const $downloadBtn = document.getElementById("downloadBtn");
  const $jobQueue = document.getElementById("jobQueue");
  const $jobList = document.getElementById("jobList");
  const $clearDoneBtn = document.getElementById("clearDoneBtn");

  let bookData = null;
  let activeTabId = null;
  let pollTimer = null;
  // Job IDs whose log is currently expanded — persists across the 500ms poll re-renders
  const expandedLogs = new Set();
  // Job IDs whose "Copy log" button is currently showing the "Copied!" feedback state
  const copiedFeedback = new Set();

  function buildLogText(job) {
    const lines = [];
    lines.push(`# ${job.bookTitle}`);
    lines.push(`Status: ${job.phase}`);
    if (job.errorMsg) lines.push(`Error: ${job.errorMsg}`);
    lines.push("");
    (job.logs || []).forEach(({ text }) => lines.push(text));
    return lines.join("\n");
  }

  // --- Settings ---

  async function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        { downloadFolder: "Academic_Books", delayMs: 500, saveAs: false },
        resolve
      );
    });
  }

  // --- Init ---

  async function init() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    activeTabId = tab.id;

    // Always poll for jobs
    startPolling();

    // Try to scrape current tab
    injectAndScrape();
  }

  function injectAndScrape() {
    chrome.scripting.executeScript(
      { target: { tabId: activeTabId }, files: ["content.js"] },
      () => {
        if (chrome.runtime.lastError) {
          showNotBookPage();
          return;
        }
        chrome.tabs.sendMessage(
          activeTabId,
          { action: "scrapeChapters" },
          (response) => {
            if (chrome.runtime.lastError || !response) {
              showNotBookPage();
              return;
            }
            bookData = response;
            renderChapters();
          }
        );
      }
    );
  }

  function showNotBookPage() {
    $notBookPage.classList.remove("hidden");
    $chapterList.classList.add("hidden");
  }

  // --- Render chapters ---

  function renderChapters() {
    $bookTitle.textContent = bookData.bookTitle;
    $chapterList.classList.remove("hidden");
    $notBookPage.classList.add("hidden");
    $chapters.innerHTML = "";

    let currentSection = null;

    bookData.chapters.forEach((ch, idx) => {
      if (ch.section && ch.section !== currentSection) {
        currentSection = ch.section;
        const header = document.createElement("div");
        header.className = "section-header";
        header.textContent = currentSection;
        $chapters.appendChild(header);
      }

      const item = document.createElement("label");
      item.className = "chapter-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      // Chapters the page marks as not licensed start unchecked.
      cb.checked = !ch.noAccess;
      cb.dataset.index = idx;
      cb.addEventListener("change", updateCount);

      const num = document.createElement("span");
      num.className = "chapter-number";
      num.textContent = ch.number || "";

      const title = document.createElement("span");
      title.className = "chapter-title";
      title.textContent = ch.title;
      title.title = ch.title;

      item.appendChild(cb);
      item.appendChild(num);
      item.appendChild(title);
      if (ch.noAccess) {
        const tag = document.createElement("span");
        tag.className = "chapter-noaccess";
        tag.textContent = "no access";
        item.appendChild(tag);
      }
      $chapters.appendChild(item);
    });

    updateCount();
  }

  function getCheckboxes() {
    return $chapters.querySelectorAll('input[type="checkbox"]');
  }

  function updateCount() {
    const boxes = getCheckboxes();
    const checked = [...boxes].filter((cb) => cb.checked).length;
    $selectedCount.textContent = `${checked} / ${boxes.length} selected`;
    $downloadBtn.disabled = checked === 0;
  }

  $selectAll.addEventListener("click", () => {
    getCheckboxes().forEach((cb) => (cb.checked = true));
    updateCount();
  });

  $deselectAll.addEventListener("click", () => {
    getCheckboxes().forEach((cb) => (cb.checked = false));
    updateCount();
  });

  // --- Queue a merge job ---

  $downloadBtn.addEventListener("click", async () => {
    const selected = [...getCheckboxes()]
      .filter((cb) => cb.checked)
      .map((cb) => bookData.chapters[parseInt(cb.dataset.index)]);

    if (selected.length === 0) return;

    const settings = await getSettings();

    $downloadBtn.disabled = true;
    $downloadBtn.textContent = "Queued!";
    setTimeout(() => {
      $downloadBtn.disabled = false;
      $downloadBtn.textContent = "Download & Merge PDF";
    }, 2000);

    chrome.runtime.sendMessage({
      action: "startMerge",
      tabId: activeTabId,
      chapters: selected,
      settings,
      bookTitle: bookData.bookTitle,
      providerInfo: {
        provider: bookData.provider,
        pdfLinkSelector: bookData.pdfLinkSelector,
        pdfLinkFallback: bookData.pdfLinkFallback,
        pdfMetaName: bookData.pdfMetaName,
        bookId: bookData.bookId,
        zipUrlTemplate: bookData.zipUrlTemplate,
        fetchMethod: bookData.fetchMethod,
        wholeBookPdfUrl: bookData.wholeBookPdfUrl,
        totalChapters: bookData.totalChapters,
        noAccessOnHtml: bookData.noAccessOnHtml,
      },
    });
  });

  // --- Job queue polling ---

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshJobs, 500);
    refreshJobs();
  }

  function refreshJobs() {
    chrome.runtime.sendMessage({ action: "getJobs" }, (resp) => {
      if (!resp || !resp.jobs) return;
      renderJobs(resp.jobs);
    });
  }

  function renderJobs(jobsList) {
    if (jobsList.length === 0) {
      $jobQueue.classList.add("hidden");
      return;
    }

    $jobQueue.classList.remove("hidden");
    $jobList.innerHTML = "";

    jobsList.forEach((job) => {
      const card = document.createElement("div");
      card.className = `job-card job-${job.phase}`;

      // Header row
      const header = document.createElement("div");
      header.className = "job-header";

      const title = document.createElement("span");
      title.className = "job-title";
      title.textContent = job.bookTitle;
      title.title = job.bookTitle;

      const badge = document.createElement("span");
      badge.className = `job-badge badge-${job.phase}`;
      badge.textContent = job.phase;

      header.appendChild(title);
      header.appendChild(badge);
      card.appendChild(header);

      // Progress bar (only for working jobs)
      if (job.phase === "working") {
        const barContainer = document.createElement("div");
        barContainer.className = "progress-bar-container";
        const bar = document.createElement("div");
        bar.className = "progress-bar";
        const pct =
          job.totalSteps > 0
            ? Math.round((job.progress / job.totalSteps) * 100)
            : 0;
        bar.style.width = pct + "%";
        barContainer.appendChild(bar);
        card.appendChild(barContainer);

        const status = document.createElement("p");
        status.className = "job-status";
        status.textContent = job.statusText;
        card.appendChild(status);
      }

      // Error message
      if (job.phase === "error" && job.errorMsg) {
        const err = document.createElement("p");
        err.className = "job-error";
        err.textContent = job.errorMsg;
        card.appendChild(err);
      }

      // Expandable log
      const isOpen = expandedLogs.has(job.id);
      const toggle = document.createElement("button");
      toggle.className = "btn btn-sm job-log-toggle";
      toggle.textContent = isOpen ? "Hide log" : "Show log";
      toggle.addEventListener("click", () => {
        const logEl = card.querySelector(".job-log");
        if (expandedLogs.has(job.id)) {
          expandedLogs.delete(job.id);
          logEl.classList.add("hidden");
          toggle.textContent = "Show log";
        } else {
          expandedLogs.add(job.id);
          logEl.classList.remove("hidden");
          toggle.textContent = "Hide log";
        }
      });
      card.appendChild(toggle);

      const copyBtn = document.createElement("button");
      copyBtn.className = "btn btn-sm job-log-copy";
      copyBtn.textContent = copiedFeedback.has(job.id) ? "Copied!" : "Copy log";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(buildLogText(job));
          copiedFeedback.add(job.id);
          refreshJobs();
          setTimeout(() => {
            copiedFeedback.delete(job.id);
            refreshJobs();
          }, 1500);
        } catch (e) {
          copyBtn.textContent = "Copy failed";
        }
      });
      card.appendChild(copyBtn);

      const logDiv = document.createElement("div");
      logDiv.className = "job-log" + (isOpen ? "" : " hidden");
      (job.logs || []).forEach(({ text, cls }) => {
        const p = document.createElement("p");
        p.className = cls || "";
        p.textContent = text;
        logDiv.appendChild(p);
      });
      card.appendChild(logDiv);

      // Remove button for done/error
      if (job.phase === "done" || job.phase === "error") {
        const removeBtn = document.createElement("button");
        removeBtn.className = "btn btn-sm job-remove";
        removeBtn.textContent = "Dismiss";
        removeBtn.addEventListener("click", () => {
          expandedLogs.delete(job.id);
          copiedFeedback.delete(job.id);
          chrome.runtime.sendMessage({ action: "clearJob", jobId: job.id });
          refreshJobs();
        });
        card.appendChild(removeBtn);
      }

      $jobList.appendChild(card);
    });
  }

  // --- Clear done jobs ---

  $clearDoneBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "clearDone" });
    refreshJobs();
  });

  init();
})();
