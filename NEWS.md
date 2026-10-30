# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.1] — 2026-10-30

### Added

- **De Gruyter Brill provider** for book pages at `degruyterbrill.com/document/doi/.../html`.
  - Reads the ordered table of contents, including part headings and page ranges,
    and uses the PDF URLs exposed by the page.
  - Respects the page's access indicators: chapters without access are shown
    unchecked and skipped without making a request.
  - Uses the full-book PDF when all chapters are selected, with a per-chapter
    fallback when the bulk download fails.
  - Detects AWS WAF challenges and reports an actionable message instead of
    continuing to request chapters.

- **JSTOR provider** for book pages at `jstor.org/stable/<bookId>`
  ([#4](https://github.com/gr0esch/Academic-Book-PDF-Merger/issues/4)).
  - Reads the server-rendered TOC (`div.toc-item[data-doi]`), including part headings,
    chapter labels and page ranges; falls back to the page's JSON-LD `hasPart` list,
    and to the whole-book PDF for books without chapter entries.
  - Per-chapter access comes from the page's own state (`childDoiAccessExperienceMap`,
    `openAccessDois`, `freeDois`): chapters outside your access start unchecked and are
    tagged "no access"; open-access chapters are tagged.
  - PDF URLs (`/stable/pdf/<id>.pdf`) are built from the current origin and fetched
    inside the book tab (`fetchMethod: "page"`). Nothing institution-specific is used.
  - Terms-and-conditions and captcha / bot-check pages stop the job with an
    actionable message instead of a PDF parse error.
- **Provider contract:** optional per-chapter `accessible` (`false` = shown unchecked but
  still requestable, unlike De Gruyter Brill's `noAccess`, which is skipped) and `access`
  (display label in the popup); optional pacing fields `minDelayMs`, `retryStatuses`,
  `retryBaseDelayMs`; and `abortOnBlock`. Other providers don't set them and behave as before.

### Changed

- **OUP downloads are much faster**
  ([#8](https://github.com/gr0esch/Academic-Book-PDF-Merger/issues/8)).
  - Up to 3 chapters are looked up and downloaded at a time (new optional provider field
    `concurrency`, capped at 4; providers that don't set it stay sequential). Merge order
    is unchanged.
  - The first chapter is tried with a plain fetch from the service worker
    (`directFetch: true`). If that returns a PDF, the whole job skips the hidden tabs;
    otherwise it falls back to hidden tabs as before.
  - Hidden tabs no longer wait a fixed 1 s and re-download the PDF. The tab is read
    ~150 ms after loading, from the HTTP cache (`cache: "force-cache"`), with one retry at
    the old 1 s mark. Non-PDF responses in a tab are now reported as a failed download
    instead of being skipped silently during the merge.
- Downloaded files are kept as bytes end to end. They are no longer base64-encoded and
  decoded again for every chapter, ZIP entry and merge step, which cuts memory use for
  large books.

### Fixed

- **Books whose merged PDF is larger than ~48 MB failed at the save step**
  ([#8](https://github.com/gr0esch/Academic-Book-PDF-Merger/issues/8)). The whole file
  was sent to the offscreen document as one base64 message, and extension messages are
  capped at 64 MiB. It is now sent in 8 MiB slices and reassembled into one Blob there.
  The job also waits for Chrome to finish writing the download before it releases the
  blob.

### Manifest

- Added `*://*.jstor.org/*` to `host_permissions`.

## [1.1.0] — 2026-05-11

### Added

- **Cambridge University Press (CUP) provider** for books on `cambridge.org/core/books/...`.
  - **ZIP-first download path.** When the book exposes the "Download PDF (zip)" button,
    the extension constructs a single GET to
    `/core/services/aop-cambridge-core/content/download/pdf/zip/{prodIds}/{bookId}`,
    downloads the bundle, unzips it client-side with [fflate](https://github.com/101arrowz/fflate),
    and merges. One request per book — fast, and invisible to per-request rate limiters.
  - **Per-chapter fallback.** When the ZIP endpoint isn't available (older books 404 it),
    the extension fetches each chapter page and reads the PDF URL from its
    `<meta name="citation_pdf_url">` tag, then downloads chapter PDFs individually.
  - **Section grouping.** CUP's TOC uses `indent-0`/`indent-1` classes to encode parts
    and chapters; the popup renders these as section headers.
  - **Skips chapters with `data-has-pdf="false"`** (e.g. some frontmatter, index pages)
    instead of failing mid-merge.
- **"Copy log" button on each job card** in the popup. Copies the full log to the
  clipboard with a one-line header (book title, phase, error if any) so logs can be
  pasted into bug reports.
- **`extension/lib/fflate.min.js`** (~32 KB, UMD build of fflate@0.8.2) for ZIP
  extraction in the service worker. pdf-lib alone cannot unzip.

### Changed

- **Binary fetches can run in the user's tab context** instead of the service worker.
  Providers opt in via a new `fetchMethod: "page"` field. This was required for CUP
  because its session cookie is `SameSite=Lax`, which `chrome-extension://` origins
  cannot send; running `fetch()` inside the authenticated book tab via
  `chrome.scripting.executeScript({ world: "MAIN" })` makes every request strictly
  same-origin to the publisher. OUP keeps its existing hidden-tab download path.
- **Provider contract gained three optional fields:**
  - `zipUrlTemplate` — URL template with an `{IDS}` placeholder for bulk-ZIP requests.
  - `pdfMetaName` — meta-tag name to consult for the per-chapter PDF URL.
  - `fetchMethod` — `"page"` routes binary fetches through MAIN-world `fetch`.
  Existing OUP behaviour is unchanged.
- **Inter-request delay has ±30% jitter.** Successive fetches are no longer perfectly
  periodic — less obviously automated to Cloudflare's bot scoring.

### Fixed

- **Job-log expansion now persists across the popup's 500ms poll re-renders**
  ([#1](https://github.com/gr0esch/Academic-Book-PDF-Merger/issues/1)). Previously,
  clicking "Show log" appeared to do nothing because `renderJobs` did a full
  `innerHTML = ""` and rebuilt the DOM every half-second, wiping the open state
  almost immediately. The popup now tracks expanded log IDs in a `Set` that survives
  re-renders.
- **Body-shape validation before pdf-lib parsing.** When CUP returns
  `Content-Type: application/pdf` but an HTML body (paywall, viewer SPA), the
  extension now detects the missing `%PDF-` header and reports it clearly with a
  printable preview of the first ~300 bytes, instead of producing 23 confusing
  "No PDF header found" parser errors.
- **Paywall detection.** A redirect to `/core/books/abs/...` (CUP's abstract /
  no-access path) is recognised and surfaced as "no access — redirected to abstract
  page" rather than a generic content-type error.
- **Retry on transient CDN failures.** Requests that come back with `429`, `502`,
  `503`, or `504` are retried up to twice with 2s → 4s exponential backoff. Retries
  are logged inline. If retries exhaust, the whole job aborts with a clear
  "rate-limited" message rather than churning through every remaining chapter.

### Manifest

- Added `*://*.cambridge.org/*` to `host_permissions`.
- Version bumped to `1.1.0`.
