// Prebuilds the views' client bundles into dist/client/<view>/ for the
// published package, which serves them as is (platform/bundle.ts).

import { mkdir, writeFile } from "node:fs/promises"
import { assetPath } from "../platform/assets.ts"
import { type ViewName, buildClientBundle, bundles } from "../platform/bundle.ts"

for (const [view, names] of Object.entries(bundles)) {
  const dir = assetPath(`dist/client/${view}`)
  await mkdir(dir, { recursive: true })
  for (const name of Object.keys(names)) {
    await writeFile(`${dir}/${name}`, await buildClientBundle(view as ViewName, name))
    console.log(`dist/client/${view}/${name}`)
  }
}
