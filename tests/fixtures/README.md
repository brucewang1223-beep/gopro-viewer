# Test fixtures

The three `.MP4` files here are 5-second excerpts (video + audio + `gpmd` telemetry track,
remuxed with ffmpeg, `-c copy`) of sample recordings published by GoPro in the
[gopro/gpmf-parser](https://github.com/gopro/gpmf-parser/tree/master/samples) repository
(Apache License 2.0). They are renamed to follow the camera's on-card naming scheme so
the library scanner can be tested:

| Fixture        | Origin       | Camera      | Notes                                   |
| -------------- | ------------ | ----------- | --------------------------------------- |
| `GX010001.MP4` | `hero6.mp4`  | Hero6 Black | GPS5 with 3D fix, 18 Hz, chapter 1      |
| `GX020001.MP4` | `hero6a.mp4` | Hero6 Black | different clip, used as chapter 2       |
| `GH010002.MP4` | `hero8.mp4`  | HERO8 Black | GPS without fix (fix = 0) — edge case   |

Remuxing drops GoPro's `udta` boxes (firmware string etc.), so firmware-related fields are
`null` for these fixtures. `npm run samples` downloads the untouched originals into
`samples/` at the project root (git-ignored) for manual testing in the viewer. Keep this
directory limited to the three fixtures: the library tests scan it recursively.
