import { DEFAULT_EXCLUSIONS } from '/shared/traffic/default-exclusions.js';
import {
  DEFAULT_TRAFFIC_LIST_ID,
  createTrafficListVisibilityMatcher
} from '/shared/traffic/traffic-lists.js';
import { normalizeHarEntries } from '/har-import.js';
import { parseCurlCommand } from '/curl-parser.js';

window.FreeKitTrafficLists = Object.freeze({
  DEFAULT_EXCLUSIONS,
  DEFAULT_TRAFFIC_LIST_ID,
  createTrafficListVisibilityMatcher
});

window.FreeKitHarImport = Object.freeze({
  normalizeHarEntries
});

window.FreeKitCurlParser = Object.freeze({
  parseCurlCommand
});

const applicationScript = document.createElement('script');
applicationScript.src = '/app.js';
applicationScript.async = false;
applicationScript.addEventListener('error', () => {
  console.error('[UI] Could not load the application script');
  const status = document.getElementById('statusText');
  if (status) status.textContent = 'Application failed to load';
});
document.body.append(applicationScript);
