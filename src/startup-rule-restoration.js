function persistMigratedRules(settings, key, collection, rules, logger) {
  try {
    settings.set(key, rules);
  } catch (error) {
    const detail = error?.message || String(error);
    logger.warn(
      `[Boot] WARNING: ${collection} were normalized in memory, but migrated settings key ` +
      `"${key}" could not be written: ${detail}. Startup will continue with the normalized runtime rules.`
    );
  }
}

export function restoreSavedRuleSettings(proxy, settings, logger = console) {
  const savedMockRules = settings.get('mockRules');
  if (savedMockRules && Array.isArray(savedMockRules) && savedMockRules.length > 0) {
    const restored = proxy.loadMockRules(savedMockRules);
    if (restored.migrated) {
      persistMigratedRules(settings, 'mockRules', 'Mock rules', restored.rules, logger);
    }
    logger.log(`[Boot] Restored ${restored.rules.length} mock rules from settings`);
  }

  const savedBreakpointRules = settings.get('breakpointRules');
  if (savedBreakpointRules !== undefined) {
    const restored = proxy.loadBreakpoints(savedBreakpointRules);
    if (restored.migrated) {
      persistMigratedRules(
        settings,
        'breakpointRules',
        'Breakpoint rules',
        restored.rules,
        logger
      );
    }
    logger.log(`[Boot] Restored ${restored.rules.length} breakpoint rules from settings`);
  }
}
