# expo-image-picker 58.0.10 and expo-document-picker 58.0.4 for photos and files in replies

The app attaches photos and files to a reply through the system's own pickers (`mobile/src/pickers.ts`). Both are the
versions Expo SDK 58 pins in `expo/bundledNativeModules.json`, and `npx expo install --check` names neither. Neither
package, nor `expo-image-loader`, which the image picker loads, has an install script, and the app installs with
scripts disabled anyway (`mobile/.npmrc`), so nothing here touches `allowBuilds`. They are native modules, so they reach
a phone only with the next native build.

## expo-image-picker none → 58.0.10

Source: mobile/node_modules/expo-image-picker/CHANGELOG.md (58.0.0 through 58.0.10), its config plugin (`plugin/build/withImagePicker.js`), its Android manifest, and `ios/ImageUtils.swift` for how each format is written

- the app picks one photo at a time and hands its uri, name, type and size to `picked`, which keeps only the kinds the host takes and files under 25 MB · test: mobile/src/attachments.test.ts
- the config plugin writes the photo library purpose string, keeps the app's microphone string for calls, and adds its default camera string, which App Store processing requires of a binary that links camera code; told the microphone is off it would block `RECORD_AUDIO` and drop the microphone string, which would take the microphone from calls · test: mobile/src/app-config.test.ts
- the module's manifest asks for `CAMERA` and, through API 32, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE`, which the app's `blockedPermissions` already removes; the merged manifest from `npx expo config --type introspect` keeps them removed and `RECORD_AUDIO` granted · not covered: checked once in the introspected config; the system photo picker on Android needs no storage permission, which only a phone proves
- `quality` 0.7 re-encodes a photo as JPEG on both platforms; iOS ignores it for PNG and BMP, so a screenshot stays a PNG; with the compatible representation iOS hands over JPEG rather than HEIC · not covered: native encoding, read in `ImageUtils.swift` and `CompressionImageExporter.kt`; needs a phone
- on Android the re-encoded file holds JPEG bytes for anything but a PNG, while the asset still reports the original's type, name and size (`MediaHandler.kt`), so the app types and names an Android photo by the bytes written · test: mobile/src/attachments.test.ts
- 58.0.5: iOS anchors the picker popover on every regular-width display and no longer crashes on iOS 27.1 checking live photo support · not covered: native, needs a phone
- 58.0.8: Android crop no longer fails for large images · not covered: the app never crops
- 58.0.9 and 58.0.10: force-bump and precompiled artifacts rebuilt for expo-modules-jsi 58.0.6, below the 58.0.21 the app has · not covered: no behaviour change

## expo-document-picker none → 58.0.4

Source: mobile/node_modules/expo-document-picker/CHANGELOG.md (58.0.0 through 58.0.4), and its config plugin, which adds iCloud entitlements only when `ios.usesIcloudStorage` is set

- the app asks for one file of the host's kinds by type, copied to the cache, and hands its uri, name, type and size to `picked` · test: mobile/src/attachments.test.ts
- the system file picker needs no permission, and the app lists no plugin for it, so the build gains no entitlement · not covered: native, needs a phone
- 58.0.1: iOS anchors the picker popover on every regular-width display · not covered: native, needs a phone
- 58.0.2: the typed config plugin takes its iCloud props · not covered: the app sets no plugin for it
- 58.0.3 and 58.0.4: force-bump and precompiled artifacts rebuilt for expo-modules-jsi 58.0.6 · not covered: no behaviour change

## expo-image-loader none → 58.0.3

Source: mobile/node_modules/expo-image-loader/CHANGELOG.md (58.0.0 through 58.0.3)

- loaded by expo-image-picker to read the picked image natively; the app never calls it, and its changelog lists no user-facing change through 58.0.1, then a force-bump (58.0.2) and precompiled artifacts rebuilt for expo-modules-jsi 58.0.6 (58.0.3) · not covered: native, reached only through the picker on a phone
