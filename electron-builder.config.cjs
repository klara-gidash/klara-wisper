// electron-builder configuration for every build of Klara Wisper.
//   scripts/dist.sh          Klara's own build: uses the engine in this checkout (build/engine-path.txt)
//   scripts/make-dmg.sh      Klara Wisper.dmg for colleagues: ships uv + the engine source, installs
//                            Python, the packages and the models on first launch (src/main/setup.ts)
//   scripts/make-windows.ps1 the Windows installer (see WINDOWS.md)
const { existsSync } = require('node:fs')

const engineSource = {
  from: 'engine',
  to: 'engine',
  filter: ['pyproject.toml', 'uv.lock', 'klara_engine/**/*.py']
}

module.exports = {
  appId: 'io.klara.wisper',
  productName: 'Klara Wisper',
  copyright: 'Klara Gidash',
  directories: { output: 'dist', buildResources: 'resources' },
  files: ['out/**', 'package.json', '!**/*.map'],
  asarUnpack: ['**/*.node'],
  npmRebuild: false,
  mac: {
    target: process.env.KLARA_MAC_TARGET === 'dmg' ? [{ target: 'dmg', arch: ['arm64'] }] : 'dir',
    icon: 'resources/icon.icns',
    category: 'public.app-category.productivity',
    minimumSystemVersion: '14.4',
    identity: '-',
    hardenedRuntime: true,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    // The helper is already signed (hardened runtime + its own entitlements) by scripts/build-helper.sh.
    signIgnore: ['KlaraHelper\\.app'],
    extraResources: [
      { from: process.env.KLARA_HELPER_APP || 'build/KlaraHelper.app', to: 'KlaraHelper.app' },
      // Klara's own build: run the engine from the checkout it was built from.
      ...(existsSync('build/engine-path.txt') && !process.env.KLARA_NO_ENGINE_PATH ? [{ from: 'build/engine-path.txt', to: 'engine-path.txt' }] : []),
      engineSource,
      // Claude skills (before / during / after a call), installed for Claude Code on launch.
      { from: 'skills', to: 'skills', filter: ['*/SKILL.md'] },
      { from: 'resources', to: '.', filter: ['tray*.png', 'health-he.wav'] }
    ],
    // uv (pinned, checksum-verified by the build script) sits next to the app binary so it is signed with it.
    extraFiles: existsSync('build/uv/uv') ? [{ from: 'build/uv/uv', to: 'MacOS/uv' }] : [],
    extendInfo: {
      NSMicrophoneUsageDescription: 'Klara Wisper מקליטה את המיקרופון כדי לתמלל, מקומית על המחשב.',
      NSAudioCaptureUsageDescription: 'Klara Wisper מקליטה את קול המשתתפים בשיחות כדי לתמלל אותם.',
      NSCalendarsFullAccessUsageDescription: 'Klara Wisper קוראת את היומן כדי לתת שם לכל הקלטה.',
      NSAppleEventsUsageDescription: 'Klara Wisper בודקת לשוניות בדפדפן כדי לזהות שיחות.'
    }
  },
  dmg: {
    title: 'Klara Wisper',
    artifactName: 'Klara Wisper.${ext}',
    writeUpdateInfo: false,
    contents: [
      { x: 150, y: 190, type: 'file' },
      { x: 450, y: 190, type: 'link', path: '/Applications' }
    ],
    window: { width: 600, height: 400 }
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icon.png',
    extraResources: [
      { from: 'build/win-helper', to: 'helper', filter: ['**/*'] },
      engineSource,
      { from: 'skills', to: 'skills', filter: ['*/SKILL.md'] },
      { from: 'build/uv-win/uv.exe', to: 'bin/uv.exe' },
      { from: 'resources', to: '.', filter: ['tray*.png', 'health-he.wav'] }
    ]
  },
  nsis: {
    oneClick: true, // no pages: double-click, it installs in seconds and opens the app's install wizard
    perMachine: false, // installs into the user's profile: no admin rights needed
    artifactName: 'Klara Wisper Setup.${ext}',
    differentialPackage: false,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Klara Wisper',
    // A real uninstall also removes %APPDATA%\Klara Wisper (engine, models, settings: about 3.5 GB);
    // an update keeps it. Transcripts in Documents\Klara Wisper are never removed.
    deleteAppDataOnUninstall: true,
    // Windows version check before installing, and Claude cleanup on uninstall.
    include: 'installer/windows/installer.nsh'
  },
  // The app binary must only ever run Klara Wisper's own code: no "run as Node", no NODE_OPTIONS,
  // no --inspect, and only the signed app.asar (checked against its hash at launch).
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true
  }
}
