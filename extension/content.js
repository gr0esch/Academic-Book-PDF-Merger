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
            // Internal state; `access` is reserved for the popup's display label.
            accessState: access,
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
    {
      name: "JSTOR",
      // Book TOC pages live at /stable/<bookId> (e.g. /stable/j.ctvcm4j72) or
      // /stable/10.xxxx/<suffix> for publisher DOIs. Journal articles, chapter pages and
      // journal issue TOCs share the /stable/ prefix, so detection additionally
      // requires a "this is a book" signal from the page's JSON-LD or SvelteKit state.
      detect() {
        if (!/^\/stable\/(?!pdf\/)./.test(window.location.pathname)) return false;
        if (!this._isJstorSite()) return false;
        const ld = this._bookJsonLd();
        if (ld) return true;
        const state = this._stateText();
        return /\bitemType:\s*"book"/.test(state) && /\bvariant:\s*"toc"/.test(state);
      },
      scrape() {
        const origin = window.location.origin;
        const ld = this._bookJsonLd();
        const access = this._accessState();

        // Book title: JSON-LD name > visible <h1> heading > <title> minus " | JSTOR".
        const headingEl = document.querySelector("jdp-pharos-heading[level='1']");
        const titleEl = document.querySelector("title");
        const bookTitle =
          this._clean(ld && (ld.name || ld.headline)) ||
          this._clean(headingEl && headingEl.textContent) ||
          this._clean(titleEl && titleEl.textContent).replace(/\s*\|\s*JSTOR\s*$/i, "") ||
          "Untitled Book";

        // Book ID from the canonical URL (falls back to the current path). Only the path
        // is used, so the code is indifferent to how the user authenticated.
        const canonical = document.querySelector("link[rel='canonical']");
        const bookPath = this._samePath(
          (canonical && canonical.getAttribute("href")) || window.location.pathname
        );
        const bookId = (bookPath.match(/^\/stable\/(.+?)\/?$/) || [])[1] || "";
        const bookDoi = (ld && this._ldDoi(ld)) || (bookId.startsWith("10.") ? bookId : `10.2307/${bookId}`);
        const bookIsOpen = access.openDois.has(bookDoi) || access.freeDois.has(bookDoi);

        const chapters = [];
        const seen = new Set();
        const addChapter = (ch) => {
          if (!ch.doi || seen.has(ch.doi) || ch.doi === bookDoi) return;
          seen.add(ch.doi);
          const acc = this._chapterAccess(ch.doi, access, bookIsOpen);
          chapters.push({
            id: ch.doi.replace(/^10\.2307\//, ""),
            number: ch.number || "",
            title: ch.title || "Untitled",
            section: ch.section || "",
            href: ch.href || "",
            pages: ch.pages || "",
            // Direct PDF URL: background skips the "find PDF link" round-trip.
            pdfUrl: ch.pdfUrl || this._pdfUrlFromDoi(ch.doi),
            accessible: acc.accessible,
            access: acc.label,
          });
        };

        // 1) Server-rendered TOC: div.toc-item[data-doi] inside ol.toc-export-list.
        document.querySelectorAll("div.toc-item[data-doi]").forEach((item) => {
          const doi = (item.getAttribute("data-doi") || "").trim();
          const link = item.querySelector("[data-qa='content title']");
          let number = "";
          let title = "";
          if (link) {
            const outer = link.querySelector(":scope > span") || link;
            const inner = outer.querySelector(":scope > span");
            title = this._clean(inner ? inner.textContent : outer.textContent);
            if (inner) {
              const clone = outer.cloneNode(true);
              clone.querySelectorAll(":scope > span").forEach((n) => n.remove());
              number = this._clean(clone.textContent).replace(/^chapter\s+/i, "");
            }
          }
          if (!title) {
            const lbl = item.querySelector("span[slot='label']");
            title = this._clean(lbl && lbl.textContent);
          }
          const pagesEl = item.querySelector(".toc-page-range");
          const pages = this._clean(pagesEl && pagesEl.textContent)
            .replace(/^\(\s*(pp?\.\s*)?/i, "")
            .replace(/\)$/, "");
          const linkHref = link && link.getAttribute("href");
          const href = linkHref ? origin + this._samePath(linkHref) : "";
          const pdfA = item.querySelector("a[href*='/stable/pdf/']");
          let pdfUrl = "";
          if (pdfA) pdfUrl = origin + this._samePath(pdfA.getAttribute("href"));
          else if (linkHref && /^\/stable\/(?!pdf\/)/.test(this._samePath(linkHref))) {
            pdfUrl = origin + this._samePath(linkHref).replace(/^\/stable\//, "/stable/pdf/") + ".pdf";
          }
          addChapter({
            doi,
            number,
            title,
            section: this._sectionFor(item),
            href,
            pages,
            pdfUrl,
          });
        });

        // 2) Fallback: JSON-LD hasPart (flat list, no part headings).
        if (chapters.length === 0 && ld && Array.isArray(ld.hasPart)) {
          ld.hasPart.forEach((part) => {
            const doi = this._ldDoi(part);
            if (!doi) return;
            const stablePath = `/stable/${doi.replace(/^10\.2307\//, "")}`;
            addChapter({
              doi,
              title: this._clean(part.name),
              href: origin + stablePath,
              pages: this._clean(part.pagination),
            });
          });
        }

        // 3) Last resort: a book without a chapter-level TOC — offer the whole-book PDF.
        if (chapters.length === 0 && bookId) {
          chapters.push({
            id: bookId,
            number: "",
            title: bookTitle,
            section: "",
            href: origin + bookPath,
            pages: "",
            pdfUrl: `${origin}/stable/pdf/${bookId}.pdf`,
            accessible: bookIsOpen ? true : access.isAuthorized,
            access: access.isAuthorized === false && !bookIsOpen ? "no access" : "",
          });
        }

        if (chapters.length === 0) return null;

        return {
          provider: "jstor",
          bookId,
          bookTitle,
          baseUrl: origin,
          chapters,
          // Same reasoning as CUP: run every fetch inside the user's authenticated tab so
          // first-party cookies (SameSite) and JSTOR's bot-detection context ride along.
          fetchMethod: "page",
          // JSTOR rate-limits and serves captchas aggressively: never go faster than
          // 3s between requests (plus jitter), back off on 403 too, and abort the whole
          // job on a terms-and-conditions or challenge page instead of hammering on.
          minDelayMs: 3000,
          retryStatuses: [403, 429, 502, 503, 504],
          retryBaseDelayMs: 5000,
          abortOnBlock: true,
        };
      },
      _clean(s) {
        return (s || "").replace(/\s+/g, " ").trim();
      },
      // Reduce any href (absolute, relative, or rewritten by a proxy) to its path so we
      // can re-anchor it on the current origin.
      _samePath(href) {
        try {
          return new URL(href, window.location.href).pathname;
        } catch (_e) {
          return "";
        }
      },
      _isJstorSite() {
        if (/(^|\.)jstor\.org$/i.test(window.location.hostname)) return true;
        const site = document.querySelector("meta[property='og:site_name']");
        return !!site && /^JSTOR$/i.test((site.getAttribute("content") || "").trim());
      },
      _bookJsonLd() {
        const scripts = document.querySelectorAll("script[type='application/ld+json']");
        for (const s of scripts) {
          let data;
          try {
            data = JSON.parse(s.textContent);
          } catch (_e) {
            continue;
          }
          const nodes = Array.isArray(data) ? data : data["@graph"] || [data];
          for (const n of nodes) {
            const t = n && n["@type"];
            if (t === "Book" || (Array.isArray(t) && t.includes("Book"))) return n;
          }
        }
        return null;
      },
      _ldDoi(node) {
        const ids = [].concat((node && node.identifier) || []);
        for (const id of ids) {
          if (id && /doi/i.test(id.propertyID || "") && id.value) return String(id.value).trim();
        }
        const url = node && (node.url || node.mainEntityOfPage);
        const m = typeof url === "string" && url.match(/\/stable\/(10\.\d+\/.+)$/);
        return m ? m[1] : "";
      },
      // SvelteKit's hydration payload (an inline <script>, JS-literal not JSON) carries
      // per-chapter access info that the rendered TOC doesn't expose as attributes.
      _stateText() {
        for (const s of document.querySelectorAll("script:not([src])")) {
          const t = s.textContent || "";
          if (/tocEntries|childDoiAccessExperienceMap/.test(t)) return t;
        }
        return "";
      },
      _accessState() {
        const state = this._stateText();
        const out = { map: {}, openDois: new Set(), freeDois: new Set(), isAuthorized: undefined };
        const objRe = /["']?childDoiAccessExperienceMap["']?\s*:\s*(\{[^{}]*\})/g;
        let m;
        while ((m = objRe.exec(state))) {
          try {
            Object.assign(out.map, JSON.parse(m[1]));
          } catch (_e) {
            /* ignore malformed */
          }
        }
        const arr = (key) => {
          const mm = state.match(new RegExp(`["']?${key}["']?\\s*:\\s*(\\[[^\\[\\]]*\\])`));
          try {
            return mm ? JSON.parse(mm[1]) : [];
          } catch (_e) {
            return [];
          }
        };
        arr("openAccessDois").forEach((d) => out.openDois.add(d));
        arr("freeDois").forEach((d) => out.freeDois.add(d));
        const auth = state.match(/["']?isAuthorized["']?\s*:\s*(true|false|!0|!1)/);
        if (auth) out.isAuthorized = auth[1] === "true" || auth[1] === "!0";
        return out;
      },
      // accessible: true (include, checked), false (shown unchecked with a note),
      // undefined (no signal either way — include and let the download step decide).
      _chapterAccess(doi, access, bookIsOpen) {
        if (bookIsOpen || access.openDois.has(doi)) return { accessible: true, label: "open access" };
        if (access.freeDois.has(doi)) return { accessible: true, label: "free" };
        const v = access.map[doi];
        if (typeof v === "string") {
          if (/full|open|free/i.test(v)) return { accessible: true, label: "" };
          return { accessible: false, label: v.replace(/_/g, " ") };
        }
        if (access.isAuthorized === false) return { accessible: false, label: "no access" };
        return { accessible: undefined, label: "" };
      },
      _pdfUrlFromDoi(doi) {
        // JSTOR-owned DOIs (10.2307/...) drop the prefix in stable URLs; publisher DOIs keep it.
        const id = doi.replace(/^10\.2307\//, "");
        return `${window.location.origin}/stable/pdf/${id}.pdf`;
      },
      // Part/section headings: every ancestor .toc-content-wrapper whose direct child is a
      // .toc-header heading contributes one level (outermost first).
      _sectionFor(item) {
        const names = [];
        let el = item.parentElement;
        while (el) {
          if (el.classList && el.classList.contains("toc-content-wrapper")) {
            const h = el.querySelector(":scope > .toc-header");
            if (h && !h.contains(item)) names.unshift(this._clean(h.textContent));
          }
          el = el.parentElement;
        }
        return names.filter(Boolean).join(" / ");
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
