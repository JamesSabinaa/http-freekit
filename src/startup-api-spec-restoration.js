export function restoreSavedApiSpecs(proxy, settings, logger = console) {
  const savedSpecs = settings.get('apiSpecs');
  if (savedSpecs === undefined) {
    return { specs: proxy.apiSpecs, discarded: 0, migrated: false };
  }

  const restored = proxy.loadApiSpecs(savedSpecs);
  if (restored.migrated) {
    try {
      settings.set('apiSpecs', structuredClone(restored.specs));
    } catch (error) {
      const detail = error?.message || String(error);
      logger.warn(
        '[Boot] WARNING: API specifications were normalized in memory, but the repaired ' +
        `settings could not be written: ${detail}. Startup will continue with the safe runtime specs.`
      );
    }
  }
  logger.log(`[Boot] Restored ${restored.specs.length} API specifications from settings`);
  return restored;
}
