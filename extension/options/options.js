(function () {
  "use strict";

  const $folder = document.getElementById("downloadFolder");
  const $delay = document.getElementById("delayMs");
  const $saveAs = document.getElementById("saveAs");
  const $saveBtn = document.getElementById("saveBtn");
  const $savedMsg = document.getElementById("savedMsg");

  // Load current settings
  chrome.storage.sync.get(
    {
      downloadFolder: "Academic_Books",
      delayMs: 500,
      saveAs: false,
    },
    (items) => {
      $folder.value = items.downloadFolder;
      $delay.value = items.delayMs;
      $saveAs.value = String(items.saveAs);
    }
  );

  $saveBtn.addEventListener("click", () => {
    chrome.storage.sync.set(
      {
        downloadFolder: $folder.value.trim(),
        delayMs: parseInt($delay.value) || 500,
        saveAs: $saveAs.value === "true",
      },
      () => {
        $savedMsg.style.display = "inline";
        setTimeout(() => {
          $savedMsg.style.display = "none";
        }, 2000);
      }
    );
  });
})();
