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
    // --- Add new publishers here ---
    // {
    //   name: "Cambridge University Press",
    //   detect() { return false; },
    //   scrape() { return null; },
    // },
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
