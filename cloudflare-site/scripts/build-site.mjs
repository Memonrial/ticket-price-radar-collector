import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const client = join(dist, 'client')

rmSync(dist, { recursive: true, force: true })
execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', client], {
  cwd: root,
  stdio: 'inherit',
})

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}
const textExtensions = new Set(['.html', '.js', '.css', '.json', '.svg'])
const assets = {}

function collect(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) collect(path)
    else {
      const extension = extname(path).toLowerCase()
      const key = `/${relative(client, path).replaceAll('\\', '/')}`
      assets[key] = {
        encoding: textExtensions.has(extension) ? 'utf8' : 'base64',
        body: readFileSync(path, textExtensions.has(extension) ? 'utf8' : 'base64'),
        contentType: mime[extension] || 'application/octet-stream',
      }
    }
  }
}

collect(client)
mkdirSync(join(dist, 'worker'), { recursive: true })
const workerSource = readFileSync(join(root, 'worker/index.js'), 'utf8')
writeFileSync(join(dist, 'worker/index.js'), workerSource.replace('/*__STATIC_ASSETS__*/', JSON.stringify(assets)))
