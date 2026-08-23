const BOOTSTRAP_DEPENDENCIES = [
  '/shared/traffic/default-exclusions.js',
  '/shared/traffic/traffic-lists.js',
  '/har-import.js',
  '/curl-parser.js',
  '/request-export.js'
];

function reportBootstrapFailure(targetDocument, logger, error) {
  logger.error('[UI] Could not load the application', error);
  const status = targetDocument.getElementById('statusText');
  if (status) status.textContent = 'Application failed to load';
}

export async function bootstrapApplication({
  importModule = specifier => import(specifier),
  targetWindow = window,
  targetDocument = document,
  logger = console
} = {}) {
  try {
    const [defaultExclusions, trafficLists, harImport, curlParser, requestExport] =
      await Promise.all(BOOTSTRAP_DEPENDENCIES.map(specifier => importModule(specifier)));

    targetWindow.FreeKitTrafficLists = Object.freeze({
      DEFAULT_EXCLUSIONS: defaultExclusions.DEFAULT_EXCLUSIONS,
      DEFAULT_TRAFFIC_LIST_ID: trafficLists.DEFAULT_TRAFFIC_LIST_ID,
      createTrafficListVisibilityMatcher: trafficLists.createTrafficListVisibilityMatcher
    });
    targetWindow.FreeKitHarImport = Object.freeze({
      normalizeHarEntries: harImport.normalizeHarEntries
    });
    targetWindow.FreeKitCurlParser = Object.freeze({
      parseCurlCommand: curlParser.parseCurlCommand
    });
    targetWindow.FreeKitRequestExport = Object.freeze({
      generateExportSnippet: requestExport.generateExportSnippet
    });

    const applicationScript = targetDocument.createElement('script');
    applicationScript.src = '/app.js';
    applicationScript.async = false;
    applicationScript.addEventListener('error', error => {
      reportBootstrapFailure(targetDocument, logger, error);
    });
    targetDocument.body.append(applicationScript);
    return true;
  } catch (error) {
    reportBootstrapFailure(targetDocument, logger, error);
    return false;
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrapApplication();
}
