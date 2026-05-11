// Content script: scrapes chapter list from academic publisher book pages.
// Each publisher has a provider with detect() and scrape() methods.
(function () {
  "use strict";

  // --- Publisher Providers ---

  const providers = [
    {
      name: "Oxford Academic (OUP)",
      detect() {
        return (
          document.querySelector("a.tocLink.js-nav-tree-link[href*='/chapter/']") !== null
        );
      },
      scrape() {
        const tocLinks = document.querySelectorAll(
          "a.tocLink.js-nav-tree-link[href*='/chapter/']"
        );
        if (tocLinks.length === 0) return null;

        const titleEl =
          document.querySelector(".book-title h1") ||
          document.querySelector("h1.document-title") ||
          document.querySelector("title");
        const bookTitle = titleEl
          ? titleEl.textContent.trim().replace(/\s*\|.*$/, "")
          : "Untitled Book";

        const baseUrl = window.location.origin;
        const chapters = [];

        tocLinks.forEach((link) => {
          const href = link.getAttribute("href");
          const chapterId =
            link.id || href.match(/chapter\/(\d+)/)?.[1] || "";
          const labelEl = link.querySelector(".tocLink-label");
          const titleSpan = link.querySelector(".tocLink-title");

          const chapterNumber = labelEl ? labelEl.textContent.trim() : "";
          const chapterTitle = titleSpan ? titleSpan.textContent.trim() : "";

          const parentLi = link
            .closest('ul[role="group"]')
            ?.closest("li.js-nav-tree-item");
          const parentTitle = parentLi
            ? parentLi
                .querySelector("h3 .tocLink-title")
                ?.textContent.trim() || ""
            : "";

          chapters.push({
            id: chapterId,
            number: chapterNumber,
            title: chapterTitle,
            section: parentTitle,
            href: href.startsWith("http") ? href : baseUrl + href,
          });
        });

        return {
          provider: "oup",
          bookTitle,
          baseUrl,
          chapters,
          // CSS selector to find the PDF link on chapter pages
          pdfLinkSelector: "a.article-pdfLink[href*='.pdf']",
          pdfLinkFallback: "a[href*='chapter-ag-pdf']",
        };
      },
    },
    {
      name: "Cambridge University Press",
      detect() {
        return (
          document.querySelector("#downloadSelectedProductParts[data-downloadcontextid]") !== null ||
          document.querySelector("div.representation.overview input[name='productParts']") !== null
        );
      },
      scrape() {
        const downloadBtn = document.querySelector(
          "#downloadSelectedProductParts[data-downloadcontextid]"
        );
        const bookIdFromBtn = downloadBtn ? downloadBtn.dataset.downloadcontextid : "";
        const bookIdFromUrl =
          window.location.pathname.match(/\/core\/books\/[^/]+\/([A-F0-9]+)/i)?.[1] || "";
        const bookId = bookIdFromBtn || bookIdFromUrl;
        if (!bookId) return null;

        const rows = document.querySelectorAll("div.representation.overview");
        if (rows.length === 0) return null;

        const titleEl =
          document.querySelector("h1.book-title") ||
          document.querySelector("meta[name='citation_book_title']") ||
          document.querySelector("title");
        let bookTitle = "Untitled Book";
        if (titleEl) {
          bookTitle = (titleEl.getAttribute("content") || titleEl.textContent || "")
            .trim()
            .replace(/\s*[|\-]\s*Cambridge Core.*$/i, "")
            .replace(/\s*\|.*$/, "");
        }

        const baseUrl = window.location.origin;
        const chapters = [];
        let currentSection = "";

        rows.forEach((row) => {
          const checkbox = row.querySelector("input[name='productParts'][data-prod-id]");
          if (!checkbox) return;

          const prodId = checkbox.dataset.prodId;
          const hasPdf = checkbox.dataset.hasPdf === "true";
          const fileSize = parseInt(checkbox.dataset.fileSize || "0", 10);

          const link = row.querySelector("a.part-link");
          const href = link ? link.getAttribute("href") : "";
          // Title text is the direct text content of the anchor, excluding the page-range div
          let title = "";
          if (link) {
            const clone = link.cloneNode(true);
            clone.querySelectorAll(".pages").forEach((n) => n.remove());
            title = clone.textContent.replace(/\s+/g, " ").trim();
          }
          const pagesEl = row.querySelector(".pages");
          const pages = pagesEl ? pagesEl.textContent.trim() : "";

          // Indent-0 = section / part header or standalone; indent-1+ = child chapter.
          // Treat any indent-0 row whose immediate following sibling is indent-1+ as a section parent.
          const isTopLevel = row.classList.contains("indent-0");
          let isSectionHeader = false;
          if (isTopLevel) {
            const next = row.nextElementSibling;
            if (
              next &&
              next.classList.contains("representation") &&
              !next.classList.contains("indent-0")
            ) {
              isSectionHeader = true;
              currentSection = title;
            } else {
              currentSection = "";
            }
          }

          if (!hasPdf || !prodId) return;

          chapters.push({
            id: prodId,
            number: "",
            title: title || "Untitled",
            section: isTopLevel ? "" : currentSection,
            href: href ? (href.startsWith("http") ? href : baseUrl + href) : "",
            pages,
            fileSize,
          });
        });

        if (chapters.length === 0) return null;

        return {
          provider: "cup",
          bookId,
          bookTitle,
          baseUrl,
          chapters,
          // ZIP-first path: comma-join selected chapter IDs in order, then book ID
          zipUrlTemplate: `${baseUrl}/core/services/aop-cambridge-core/content/download/pdf/zip/{IDS}/${bookId}`,
          // Per-chapter fallback: chapter page exposes the PDF URL via citation_pdf_url meta
          pdfMetaName: "citation_pdf_url",
          // CUP session cookies are SameSite-restricted — fetch from the page context,
          // not from the service worker or a fresh hidden tab.
          fetchMethod: "page",
        };
      },
    },
  ];

  // --- Main ---

  function scrapeBookPage() {
    for (const provider of providers) {
      if (provider.detect()) {
        return provider.scrape();
      }
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "scrapeChapters") {
      sendResponse(scrapeBookPage());
    }
    return false;
  });
})();
