import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const client = join(dist, 'client')

rmSync(dist, { recursive: true, force: true })
execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', client], {
  cwd: root,
  stdio: 'inherit',
})
