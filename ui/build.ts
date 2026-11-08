// Builds the Orchestra Board editor into the plugin: ../editor/{index.html, main.js, main.css}.
// The plugin loads no packages at runtime, so React, Radix, cmdk and dnd-kit are bundled in.
import { $ } from 'bun'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const out = join(import.meta.dir, '..', 'editor')
await mkdir(out, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, 'src', 'main.tsx')],
  outdir: out,
  naming: 'main.js',
  target: 'browser',
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await $`bunx @tailwindcss/cli -i ${join(import.meta.dir, 'src', 'styles.css')} -o ${join(out, 'main.css')} --minify`.quiet()

await writeFile(
  join(out, 'index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orchestra Board</title>
    <link rel="stylesheet" href="./main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
`
)
console.log(`Built ${out}`)
