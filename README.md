# Academic Book PDF Merger

A Chrome extension that downloads individual chapter PDFs from academic publisher book pages and merges them into a single PDF file.

## The Problem

Many academic publishers (Oxford Academic, etc.) provide access to book chapters as individual PDFs. Downloading and combining 20+ chapter PDFs manually is tedious and time-consuming.

## The Solution

This extension adds a one-click workflow: select chapters, click merge, get a single PDF. It runs entirely in the browser using your existing institutional/personal authentication -- no external servers, no API keys, no credentials to share.

## Supported Publishers

| Publisher | Status | Domain |
|-----------|--------|--------|
| Oxford Academic (OUP) | Supported | `academic.oup.com` |
| Cambridge University Press (CUP) | Supported | `cambridge.org` |
| De Gruyter Brill | Supported | `degruyterbrill.com` |
| JSTOR | Supported | `jstor.org` (books only) |
| Springer | Planned | |
| Wiley | Planned | |

## Features

- **Chapter selection**: View the full table of contents with checkboxes, grouped by section/part. All selected by default, deselect what you don't need.
- **Job queue**: Queue multiple books from different tabs. Jobs run concurrently in the background.
- **Background processing**: Closing the popup doesn't cancel the merge. Reopen to check progress.
- **Progress tracking**: Real-time progress bar and detailed log for each job.
- **In-browser merging**: Uses [pdf-lib](https://pdf-lib.js.org/) for client-side PDF merging. No data leaves your browser.
- **Configurable**: Set download folder, request delay, and more in extension settings.

## Installation

### From source (developer mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/gr0esch/Academic-Book-PDF-Merger.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the `extension/` folder from this repository

### From Chrome Web Store

_Not yet published._

## Usage

1. Navigate to a supported publisher's book page (e.g., a book on `academic.oup.com`, or a `degruyterbrill.com/document/doi/.../html` book page)
2. Click the extension icon in the toolbar
3. The chapter list appears with all chapters selected by default
4. Deselect any chapters you don't need (front matter, index, etc.). Chapters the page marks as not licensed for you are shown as "no access" and start unchecked
5. Click **Download & Merge PDF**
6. The job runs in the background -- you can close the popup, switch tabs, or queue more books
7. The merged PDF is saved to your Downloads folder (subfolder configurable in settings)

## Settings

Right-click the extension icon and select **Options**, or go to `chrome://extensions` and click **Details > Extension options**.

| Setting | Default | Description |
|---------|---------|-------------|
| Download subfolder | `Academic_Books` | Subfolder within your Downloads directory |
| Request delay | `500ms` | Delay between chapter fetches to avoid rate limiting (JSTOR always uses at least 3s) |
| Save As dialog | Off | Whether to show a file picker for each merged PDF |

### JSTOR notes

- Works on book pages (`jstor.org/stable/<book id>`) for any kind of access: institutional IP range, Shibboleth/OpenAthens login, or a personal JSTOR account. Journal articles and journal issues are not handled.
- Chapters JSTOR marks as outside your access are listed but unchecked, tagged "no access"; open-access chapters are tagged "open access".
- The first time you download from JSTOR in a session, JSTOR may ask you to accept its Terms and Conditions. The extension does not accept them for you: if the job stops with that message, click **Download** on one chapter in the book tab, accept, and start the merge again.
- To avoid JSTOR's bot protection, requests are spaced at least 3 seconds apart (with jitter), 403/429 responses are retried with backoff, and the job stops immediately if a captcha or bot check appears.
- If you reach JSTOR through a proxy that rewrites the hostname (e.g. `www-jstor-org.ezproxy.<university>.edu`), the page is outside the extension's host permissions and may not work.

## How It Works

1. **Content script** detects the publisher and scrapes the chapter list from the book's table of contents page
2. **Background service worker** orchestrates the merge job:
   - Finds each chapter's PDF URL: taken straight from the table of contents where the publisher lists it (De Gruyter Brill, JSTOR), otherwise by fetching the chapter page (in the page's context, with your session cookies)
   - Downloads each PDF either in a hidden background tab (OUP) or with a fetch from your own book tab (CUP, De Gruyter Brill, JSTOR), so your session cookies and any bot-protection token are sent
   - Checks that every download really is a PDF (`%PDF-` header) and reports paywall, terms-acceptance and captcha pages clearly
   - Uses a single bulk download instead when the publisher offers one (CUP chapter ZIP; De Gruyter Brill full-book PDF when all chapters are selected)
   - Merges all PDFs in order using pdf-lib
   - Triggers the final download via the Chrome downloads API

## Architecture

```
extension/
  manifest.json         # Chrome MV3 manifest
  background.js         # Service worker: job queue, merge orchestration
  content.js            # Content script: publisher detection + chapter scraping
  offscreen.html/js     # Offscreen document: blob URL creation for downloads
  popup/
    popup.html/js/css   # Extension popup: chapter selection + job queue UI
  options/
    options.html/js     # Settings page
  lib/
    pdf-lib.min.js      # PDF merging library (client-side)
    fflate.min.js       # ZIP extraction (CUP bulk download)
  icons/
    icon16/48/128.png   # Extension icons
```

### Adding a New Publisher

1. Open `content.js`
2. Add a new provider object to the `providers` array:
   ```javascript
   {
     name: "Publisher Name",
     detect() {
       // Return true if the current page is a book TOC for this publisher
       return document.querySelector(".some-unique-selector") !== null;
     },
     scrape() {
       // Return { provider, bookTitle, baseUrl, chapters, pdfLinkSelector, pdfLinkFallback }
       // chapters: [{ id, number, title, section, href }]
       // Optional: pdfMetaName, fetchMethod: "page", zipUrlTemplate (CUP),
       // wholeBookPdfUrl + totalChapters, noAccessOnHtml; per chapter: pdfUrl, noAccess
     },
   }
   ```
3. Add the publisher's domain to `host_permissions` in `manifest.json`
4. The background worker handles the rest -- it uses the `pdfLinkSelector` from your provider to find PDF links on chapter pages
5. Optional fields (see the CUP and JSTOR providers): `pdfMetaName`, `zipUrlTemplate`, `fetchMethod: "page"`; per chapter `pdfUrl` (skip the chapter-page lookup) and `accessible: false` (start unchecked) with an `access` label; pacing `minDelayMs`, `retryStatuses`, `retryBaseDelayMs`; and `abortOnBlock` (stop the job on terms or captcha pages). New fields must also be forwarded in `popup.js` (`providerInfo`)

## Requirements

- Google Chrome (version 116+ for Manifest V3 + offscreen API)
- Institutional or personal access to the publisher's content (the extension uses your existing browser session)

## Privacy

- **No data collection**: The extension does not collect, transmit, or store any personal data
- **No external servers**: All processing happens locally in your browser
- **Session-based**: Uses your existing browser session for authentication -- no credentials are stored or transmitted by the extension
- **Permissions are scoped**: Host permissions are limited to supported publisher domains

## License

MIT
