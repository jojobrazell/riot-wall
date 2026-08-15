# Self-hosted 8th Wall XR engine (MIT, built from source)

The baked-in AR viewer (`app/ar/[card_id]`) loads the XR engine from this folder,
same-origin: `<script src="/ar/engine/xr.js" data-preload-chunks="slam">`.
Image-target tracking (`XR8.XrController`, in `xr-tracking.js`) is registered
under the chunk name `slam` in this build — preloading any other name (e.g.
`tracking`) logs "unknown chunk" and leaves `XR8.XrController` null. There is no
separate `xr-slam.js`; world-tracking SLAM is stripped, only the name remains.

The engine is **already built and vendored here** (`xr.js`, `xr-tracking.js`,
`xr-face.js`, `resources/`, `LICENSE`). Rebuild only to update the version.

We deliberately use the **MIT-licensed open-source engine**
(<https://github.com/8thwall/8thwall> → `packages/engine`), **not** the prebuilt
`@8thwall/engine-binary` npm package. The prebuilt binary is under Niantic's
restrictive *XR Engine License* (no use in a paid product whose value derives
substantially from it, mandatory attribution, revocable). The MIT engine
includes Image Target tracking — which is all the contact-sharing experience
needs — with no proprietary binary.

## One-time build

The MIT engine is not published to npm; it is built from source with Bazel +
WASM and the output is committed here.

```bash
git clone https://github.com/8thwall/8thwall.git
cd 8thwall
# SIMD build (preferred):
bazel build --config=wasmreleasesimd //reality/app/xr/js:bundle
# …or non-SIMD:
# bazel build --config=wasmrelease //reality/app/xr/js:bundle
```

The target produces `bazel-bin/reality/app/xr/js/bundle.zip`; unzip it into this
folder. Contents:

```
apps/mixr-studio/public/ar/engine/
├── xr.js             # engine core
├── xr-tracking.js    # loaded by data-preload-chunks="slam" (image targets / XrController)
├── xr-face.js        # face tracking (unused by contact-sharing; harmless)
├── resources/...     # workers, tflite models, glb, powered-by.svg
└── LICENSE           # MIT (Niantic Spatial)
```

`scripts/build-8thwall-engine.sh` automates clone (needs git-lfs) + build + unzip.

A helper that automates clone+build+copy lives at
`apps/mixr-studio/scripts/build-8thwall-engine.sh`.

## Local patches (RE-APPLY AFTER ANY REBUILD)

This OSS build leaves the `disableWorldTracking` config unwired, so it refuses
camera image-tracking on non-mobile devices (the editor Preview / desktop). We
want the experience to run on desktop too, so two `!K`-gated guards in
`xr-tracking.js` are neutered (the `throw`s are forced unreachable). A rebuild
overwrites `xr-tracking.js` — re-run these afterward:

```bash
cd apps/mixr-studio/public/ar/engine
perl -i -pe 's/\Qif(I.fillsCameraTexture&&!sQ().isDeviceBrowserCompatible(g))\E/if(!1)/g' xr-tracking.js
perl -i -pe 's/\Qif(g!==kg().camera().BACK&&!K)\E/if(!1)/g' xr-tracking.js
```

Guard 1 = "Reality with camera on non-mobile devices requires disableWorldTracking";
guard 2 = "World tracking is only supported on the back camera". If the minified
identifiers (`sQ`, `kg`, `K`, `g`) drift in a new build, update the anchors to match.

## Notes

- The viewer degrades gracefully if `xr.js` is absent (shows an "AR engine not
  installed" message) so the app still builds and runs without the engine.
- Keep the engine's `LICENSE` (MIT) alongside the bundle and retain the upstream
  copyright notice.
