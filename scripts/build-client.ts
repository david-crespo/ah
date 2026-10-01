// Prebuilds the apps' client bundles into dist/client/<app>/ for the
// published package, which serves them as is (host/bundle.ts).

import { mkdir, writeFile } from "node:fs/promises"
import { assetPath } from "../host/assets.ts"
import { type BundleApp, buildClientBundle, bundles } from "../host/bundle.ts"

for (const [app, names] of Object.entries(bundles)) {
  const dir = assetPath(`dist/client/${app}`)
  await mkdir(dir, { recursive: true })
  for (const name of Object.keys(names)) {
    await writeFile(`${dir}/${name}`, await buildClientBundle(app as BundleApp, name))
    console.log(`dist/client/${app}/${name}`)
  }
}
