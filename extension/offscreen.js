// Offscreen document: creates blob URLs for downloads
// (service workers can't use URL.createObjectURL)

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "createBlobUrl") {
    try {
      const binary = atob(message.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      sendResponse({ url });
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return false;
  }
});
