const PROXY_BYPASS_PREFIX = '--proxy-bypass-list=';
const LOOPBACK_BYPASS_RULE = '<-loopback>';

export function ensureChromiumLoopbackProxying(args) {
  const normalizedArgs = [];
  const bypassRules = [];
  let bypassIndex = null;

  for (const arg of args) {
    if (typeof arg === 'string' && arg.startsWith(PROXY_BYPASS_PREFIX)) {
      bypassIndex ??= normalizedArgs.length;
      bypassRules.push(
        ...arg.slice(PROXY_BYPASS_PREFIX.length).split(';').filter(Boolean)
      );
    } else {
      normalizedArgs.push(arg);
    }
  }

  if (bypassIndex === null) {
    const proxyIndex = normalizedArgs.findIndex(arg =>
      typeof arg === 'string' && arg.startsWith('--proxy-server=')
    );
    bypassIndex = proxyIndex >= 0 ? proxyIndex + 1 : normalizedArgs.length;
  }

  const uniqueRules = [...new Set([...bypassRules, LOOPBACK_BYPASS_RULE])];
  normalizedArgs.splice(
    bypassIndex,
    0,
    `${PROXY_BYPASS_PREFIX}${uniqueRules.join(';')}`
  );
  return normalizedArgs;
}
