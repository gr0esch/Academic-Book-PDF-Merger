# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
