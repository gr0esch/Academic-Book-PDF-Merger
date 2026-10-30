// Offscreen document: creates blob URLs for downloads
// (service workers can't use URL.createObjectURL)
//
// The file arrives in base64 slices (blobStart, blobChunk × n, blobFinish) because a
// single extension message is capped at 64 MiB.

const pending = new Map(); // id -> Uint8Array[]

function fromBase64(b64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    switch (message.action) {
      case "blobStart":
        pending.set(message.id, []);
        sendResponse({ ok: true });
        return false;
      case "blobChunk": {
        const parts = pending.get(message.id);
        if (!parts) throw new Error("Unknown blob id");
        parts.push(fromBase64(message.base64));
        sendResponse({ ok: true });
        return false;
      }
      case "blobFinish": {
        const parts = pending.get(message.id);
        if (!parts) throw new Error("Unknown blob id");
        pending.delete(message.id);
        const blob = new Blob(parts, { type: "application/pdf" });
        sendResponse({ url: URL.createObjectURL(blob) });
        return false;
      }
      case "blobRevoke":
        URL.revokeObjectURL(message.url);
        sendResponse({ ok: true });
        return false;
    }
  } catch (e) {
    pending.delete(message.id);
    sendResponse({ error: e.message });
  }
  return false;
});
