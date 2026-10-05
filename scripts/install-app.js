// Runs the installer that `npm run dist` just built (silent install, then starts Studio).
const { execFileSync, spawn } = require('child_process')
const { readdirSync, statSync } = require('fs')
const { join } = require('path')

const dist = join(__dirname, '..', 'dist')
const setup = readdirSync(dist)
  .filter((f) => /^Studio Setup .*\.exe$/.test(f))
  .map((f) => join(dist, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
if (!setup) {
  console.error('No installer in dist/. Run `npm run dist` first.')
  process.exit(1)
}

// The installer can't replace files while Studio is open.
try {
  execFileSync('taskkill', ['/IM', 'Studio.exe', '/F'], { stdio: 'ignore' })
  console.log('Closed the running Studio.')
} catch {
  // wasn't running
}

console.log(`Installing ${setup} …`)
execFileSync(setup, ['/S'], { stdio: 'inherit' })
const exe = join(process.env.LOCALAPPDATA, 'Programs', 'studio', 'Studio.exe')
console.log(`Installed: ${exe}`)
spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
