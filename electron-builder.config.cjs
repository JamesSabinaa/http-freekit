/**
 * electron-builder configuration for HTTP FreeKit.
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'io.freekit.http-freekit',
  productName: 'HTTP FreeKit',
  copyright: 'Copyright © 2026 HTTP FreeKit',

  directories: {
    output: 'dist',
    buildResources: 'build'
  },

  files: [
    'electron/**/*',
    'src/**/*',
    'build/icon.png',
    'build/icons/**/*',
    'package.json',
    '!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}',
    '!**/node_modules/*/{test,__tests__,tests,powered-test,example,examples}',
    '!**/node_modules/*.d.ts',
    '!**/node_modules/.bin',
    '!**/*.{iml,o,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,xproj}',
    '!.editorconfig',
    '!**/._*',
    '!**/{.DS_Store,.git,.hg,.svn,CVS,RCS,SCCS,.gitignore,.gitattributes}',
    '!**/{thumbs.db,ehthumbs.db,desktop.ini}',
    // Exclude dev/build files
    '!scripts',
    '!tasks',
    '!data',
    '!prd.json',
    '!progress.txt',
    '!COMPARISON.md',
    '!.claude'
  ],

  extraResources: [
    // data/ is NOT bundled — the app generates CA certs at runtime
  ],

  // --- Windows ---
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] }
    ],
    icon: 'build/icon.ico'
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    shortcutName: 'HTTP FreeKit'
  },

  // --- macOS ---
  mac: {
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] }
    ],
    icon: 'build/icon.png',
    category: 'public.app-category.developer-tools'
  },

  dmg: {
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' }
    ]
  },

  // --- Linux ---
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] }
    ],
    icon: 'build/icons',
    category: 'Development',
    synopsis: 'HTTP(S) debugging, interception & testing toolkit',
    description: 'Free HTTP(S) debugging proxy for intercepting, viewing, and mocking HTTP traffic.'
  },

  // Auto-update: publish to GitHub Releases by default
  publish: [
    {
      provider: 'github',
      owner: 'AmenRa',
      repo: 'http-freekit'
    }
  ],

  // Rebuild native dependencies for the target Electron version
  npmRebuild: true,

  // asar enabled — the electron/ shell stays packed for performance.
  // src/ and all node_modules are unpacked because the server runs as a
  // child process with ESM imports, which requires real filesystem paths.
  asar: true,
  asarUnpack: [
    'src/**/*',
    'node_modules/**/*'
  ]
};
