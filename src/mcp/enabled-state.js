export const MCP_ENABLED_SETTING = 'mcpEnabled';

export function resolveMcpEnabled(settings) {
  // Preserve the historical enabled-by-default behavior. Only a successfully
  // persisted, explicit false disables MCP on the next launch.
  return settings?.get(MCP_ENABLED_SETTING, true) !== false;
}
