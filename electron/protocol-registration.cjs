const path = require('path');

function registerDefaultProtocolClient({
  app,
  scheme,
  defaultApp = false,
  execPath,
  argv = [],
  resolvePath = path.resolve
}) {
  const development = Boolean(defaultApp && argv[1]);
  const args = development
    ? [scheme, execPath, [resolvePath(argv[1])]]
    : [scheme];

  try {
    if (app.setAsDefaultProtocolClient(...args) === true) {
      return { registered: true, development, error: null };
    }
    return {
      registered: false,
      development,
      error: 'The operating system declined the registration request.'
    };
  } catch (error) {
    return {
      registered: false,
      development,
      error: error?.message || String(error)
    };
  }
}

function getProtocolRegistrationWarning(result, scheme) {
  const sourceLaunchGuidance = result?.development
    ? ' Source launches may not be eligible for automatic registration.'
    : '';
  return {
    type: 'warning',
    title: 'Link Integration Unavailable',
    message: `HTTP FreeKit could not register ${scheme}: links.`,
    detail: `${result?.error || 'Protocol registration failed.'}${sourceLaunchGuidance}\n\nReinstall the packaged application or choose HTTP FreeKit for ${scheme}: links in your operating system's Default Apps settings.`,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0
  };
}

module.exports = { getProtocolRegistrationWarning, registerDefaultProtocolClient };
