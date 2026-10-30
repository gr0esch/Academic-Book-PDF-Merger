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
    {
      name: "De Gruyter Brill",
      // Book landing pages: /[lang/]document/doi/<book-doi>/html. Detect on the
      // markup rather than the hostname so the same code works on any host the
      // page is served from.
      detect() {
        return (
          document.querySelector("ul.toc_new_book li.toc_entry a.entry-anchor[data-doi]") !== null
        );
      },
      scrape() {
        const entries = document.querySelectorAll(".toc_new_book li.toc_entry");
        if (entries.length === 0) return null;

        const baseUrl = window.location.origin;
        // The site emits absolute links to its canonical host. Rebase them onto
        // the origin the user is actually on, so the in-tab fetch stays
        // same-origin and carries the user's own session.
        const toLocalUrl = (href) => {
          const u = new URL(href, window.location.href);
          return u.origin === baseUrl ? u.href : baseUrl + u.pathname + u.search;
        };
        // The page's own JS resolves access asynchronously (POST /access/dois)
        // and un-hides either `.contentAvailable` or `.notAvailable`.
        const visible = (root, sel) =>
          [...root.querySelectorAll(sel)].some((el) => !el.closest(".d-none"));

        // Book DOI, with or without a language prefix (/de/, /en/, ...).
        const doiFromPath = (p) =>
          (p || "").match(/\/document\/doi\/(10\.\d{4,9}\/[^/?#]+)/)?.[1] || "";
        const canonical = document.querySelector("link[rel='canonical']");
        const bookDoi =
          doiFromPath(window.location.pathname) ||
          doiFromPath(canonical ? new URL(canonical.href, window.location.href).pathname : "") ||
          document.querySelector("current-price[doi]")?.getAttribute("doi") ||
          "";

        const titleEl =
          document.querySelector("h1.title-dgb") ||
          document.querySelector("meta[name='citation_inbook_title']") ||
          document.querySelector("meta[property='og:title']") ||
          document.querySelector("title");
        let bookTitle = "Untitled Book";
        if (titleEl) {
          bookTitle =
            (titleEl.getAttribute("content") || titleEl.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .replace(/\s*\|\s*De Gruyter.*$/i, "") || bookTitle;
        }

        const chapters = [];
        const seen = new Set();
        let currentSection = "";

        // Part / section headings, if the book has any, are rendered as
        // `.entry-subheading` rows between the chapter entries.
        const rows = document.querySelectorAll(
          ".toc_new_book li.toc_entry, .toc_new_book .entry-subheading"
        );
        rows.forEach((row) => {
          if (row.classList.contains("entry-subheading")) {
            if (!row.closest("li.toc_entry")) {
              currentSection = row.textContent.replace(/\s+/g, " ").trim();
            }
            return;
          }
          const sub = row.querySelector(".entry-subheading");
          if (sub) currentSection = sub.textContent.replace(/\s+/g, " ").trim();

          const anchor = row.querySelector("a.entry-anchor[data-doi]");
          if (!anchor) return;
          const doi = anchor.dataset.doi;
          if (!doi || seen.has(doi)) return;

          // Only entries with a PDF link (some are print-only or EPUB-only).
          // The link is rendered for every entry the platform has a PDF for,
          // whether or not the user is licensed; access is shown separately.
          const pdfLink = [...row.querySelectorAll("a.downloadPdf[href]")].find(
            (a) => !a.dataset.doi || a.dataset.doi === doi
          );
          if (!pdfLink) return;
          seen.add(doi);

          const titleNode = row.querySelector(".entry-title");
          const title = titleNode
            ? titleNode.textContent.replace(/\s+/g, " ").trim()
            : anchor.getAttribute("aria-label") || doi;
          const pages = row.querySelector(".entry-number")?.textContent.trim() || "";

          // Access: free / open-access entries carry a badge and no indicator;
          // licensed entries get `.contentAvailable` or `.notAvailable` shown.
          // "unknown" (indicator not resolved yet) is attempted and validated.
          let access = "unknown";
          if (visible(row, ".badge.freeAccess, .badge.openAccess, .badge.contentFree")) {
            access = "free";
          } else if (visible(row, ".badge.contentAvailable")) {
            access = "licensed";
          } else if (visible(row, ".badge.notAvailable")) {
            access = "none";
          }

          chapters.push({
            id: doi,
            number: "",
            title: title || "Untitled",
            section: currentSection,
            href: toLocalUrl(anchor.getAttribute("href") || `/document/doi/${doi}/html`),
            pdfUrl: toLocalUrl(pdfLink.getAttribute("href")),
            pages,
            access,
            noAccess: access === "none",
          });
        });

        if (chapters.length === 0) return null;

        // Whole-book PDF: only when the page itself offers one. The site shows
        // `.alternateForms` (download-the-book links) only once its access check
        // says the user is authorized for the whole title.
        let wholeBookPdfUrl = "";
        const altForms = document.querySelector(".alternateForms");
        if (altForms && !altForms.closest(".d-none")) {
          const a = [...altForms.querySelectorAll("a[href]")].find((el) =>
            /\/pdf(?:[?#]|$)/i.test(new URL(el.getAttribute("href"), window.location.href).pathname)
          );
          if (a) wholeBookPdfUrl = toLocalUrl(a.getAttribute("href"));
        }

        return {
          provider: "degruyter",
          bookId: bookDoi,
          bookTitle,
          baseUrl,
          chapters,
          // Per-chapter PDF URLs come straight from the TOC (`pdfUrl`), so no
          // chapter-page round trip is needed.
          wholeBookPdfUrl,
          totalChapters: chapters.length,
          // The site sits behind AWS WAF bot protection; its token cookie and
          // the session only ride along reliably on same-origin requests from
          // the user's own tab.
          fetchMethod: "page",
          // A non-PDF (HTML) answer to a PDF URL means login wall / landing page.
          noAccessOnHtml: true,
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
