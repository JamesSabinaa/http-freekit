(function initDesktopVersionHydration() {
  const MAX_VERSION_LENGTH = 64;
  const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

  function validateDesktopVersion(value) {
    if (typeof value !== 'string') return null;
    const version = value.trim();
    if (!version || version.length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(version)) return null;
    return version;
  }

  function hydrateDesktopVersion() {
    const desktopApi = window.electronApi;
    if (!desktopApi || typeof desktopApi.getDesktopVersion !== 'function') return;

    Promise.resolve()
      .then(function() { return desktopApi.getDesktopVersion(); })
      .then(function(value) {
        const version = validateDesktopVersion(value);
        if (!version) return;

        const logo = document.getElementById('desktopVersionLogo');
        const valueElement = document.getElementById('desktopVersionValue');
        if (logo) logo.setAttribute('title', 'HTTP FreeKit v' + version);
        if (valueElement) valueElement.textContent = version;
      })
      .catch(function() {
        // Keep the static version fallback when the desktop bridge is unavailable.
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateDesktopVersion, { once: true });
  } else {
    hydrateDesktopVersion();
  }
})();
