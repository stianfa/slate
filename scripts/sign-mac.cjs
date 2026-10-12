// electron-builder afterSign hook. CI signs the Mac app with the "Slate Self-Signed" certificate
// from the MAC_CERT_P12 secret, so every build carries the same signature. macOS ties keychain
// access to that signature: with ad-hoc signing each build counted as a new app and could no longer
// read the connection passwords and API key earlier builds had saved. Builds without
// SLATE_SIGN_IDENTITY (local ones, or CI without the secret) keep the ad-hoc signature.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function signMac(context) {
  const identity = process.env.SLATE_SIGN_IDENTITY
  if (context.electronPlatformName !== 'darwin' || !identity) return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const keychain = process.env.SLATE_SIGN_KEYCHAIN ? ['--keychain', process.env.SLATE_SIGN_KEYCHAIN] : []
  // --deep also signs the helper apps and frameworks inside. There is no hardened runtime, so no entitlements.
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, ...keychain, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  // The designated requirement is what the keychain checks; it must not change between builds.
  execFileSync('codesign', ['--display', '--requirements', '-', app], { stdio: 'inherit' })
}
