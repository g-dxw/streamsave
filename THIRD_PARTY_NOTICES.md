# Third-party notices

This file records third-party components redistributed with StreamSave. Their original licenses and notices remain applicable to their respective files. This document does not select a license for StreamSave's own source code.

## hls.js playback bundle

The prebuilt `public/vendor/hls.js` is built from [hls.js](https://github.com/video-dev/hls.js), version `1.7.4-10-gcb22168d8`, revision `cb22168d8088aceca4c6934d70d8d035be31d607`. The source revision is available [upstream](https://github.com/video-dev/hls.js/tree/cb22168d8088aceca4c6934d70d8d035be31d607). Build provenance is recorded in [hls-source.json](public/vendor/hls-source.json).

The upstream copyright and derivative-work notice is preserved in [hls.LICENSE](public/vendor/hls.LICENSE). The complete Apache License 2.0 text is included in [Apache-2.0.LICENSE](public/vendor/Apache-2.0.LICENSE), copied verbatim from url-toolkit's license file with its attribution retained. The bundle wrapper and build configuration are maintained in `scripts/build.mjs`.

The following dependencies are included in the actual esbuild input graph, including transitive packages. Their original license and any NOTICE files are copied during every build:

| Component | Version | License | Original files |
| --- | --- | --- | --- |
| @svta/cml-cmcd | 2.4.0 | Apache-2.0 | [LICENSE](public/vendor/licenses/@svta/cml-cmcd/LICENSE) |
| @svta/cml-id3 | 1.0.6 | Apache-2.0 | [LICENSE](public/vendor/licenses/@svta/cml-id3/LICENSE) |
| @svta/cml-structured-field-values | 1.1.3 | Apache-2.0 | [LICENSE](public/vendor/licenses/@svta/cml-structured-field-values/LICENSE) |
| @svta/cml-utils | 1.5.0 | Apache-2.0 | [LICENSE](public/vendor/licenses/@svta/cml-utils/LICENSE) |
| eventemitter3 | 5.0.4 | MIT | [LICENSE](public/vendor/licenses/eventemitter3/LICENSE) |
| url-toolkit | 2.2.5 | Apache-2.0 | [LICENSE](public/vendor/licenses/url-toolkit/LICENSE) |

## Font and icons

| Component | Package version | License | Original file |
| --- | --- | --- | --- |
| [Geist](https://github.com/vercel/geist-font), distributed by @fontsource/geist | 5.3.0 | SIL Open Font License 1.1 | [geist.LICENSE](public/vendor/geist.LICENSE) |
| [Phosphor Icons](https://github.com/phosphor-icons/core) | 2.1.1 | MIT | [phosphor.LICENSE](public/vendor/phosphor.LICENSE) |

## External runtime

StreamSave invokes an independently installed FFmpeg/ffprobe executable. These executables are not bundled in this repository; their licenses depend on the installed FFmpeg build.
