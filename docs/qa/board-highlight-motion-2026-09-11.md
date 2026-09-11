# Board highlight motion — 2026-09-11

Recommendations and line previews now use the existing pointer-transparent SVG overlay so both
ordinary recommendations and execution marks can animate and survive board presses. Replacement
is atomic; the bridge also removes any native markings it previously owned.

Squares fade in over 200 ms while the arrow shaft draws from origin to destination over 340 ms
with its arrowhead travelling at the same rate. The arrow holds for 180 ms, then both squares
and arrow fade out together from 520–820 ms and are removed. Square-only highlights follow
the same fade-in, hold and fade-out timeline. This uses native Web Animations, with no polling
or RAF loop. Reduced-motion preference retains static usable marks until the lifecycle clears
them, including when only square highlights are enabled.

The arrow is one rounded path, so there is no separate translucent shaft/head overlap.
Its source fades to transparent. A faint blurred shadow replaces the perimeter outline;
its offset stays screen-down in either board orientation, giving subtle depth without a border.
The complete silhouette grows through native path keyframes and settles from a slight brightness
lift while drawing. Paint gradients use per-build, per-arrow IDs and are removed with their
captured group. Native Chromium review confirmed path interpolation and the source gradient.

Identical requests are deduplicated at the page's current SVG, so a hand-start update does not
replay either animation, even after all marks have faded from the SVG. The page still repairs
an identical mark after a board replacement, including a replacement after the previous fade
finished. Clear or a changed recommendation cancels old animations; completion callbacks remove
only their captured nodes and cannot remove newer marks even if completion was already queued.
Existing session lifecycle clears remain in force after moves and position changes.

Validation:

- The square fade-out revision passed 30 focused tests: 13 overlay, 15 page bridge, and 2
  game-session highlight lifecycle tests. Assertions cover synchronized square/arrow keyframes,
  square-only fading, duplicate requests before and after fade, cancelled and already-completed
  animation callbacks, replaced boards, and reduced motion. The preceding highlight change also
  passed the content command and complete content-to-page chain suites.
- Constants checks and targeted Biome checks passed.
- Rounded silhouette, mirrored direction, source gradient, soft shadow, paint-ID replacement, and
  the existing fade lifecycle passed 13 overlay, 15 bridge, and 3 content-to-page tests.
- Native review fixture: `/tmp/sliced-highlight-fixture.html`, served at
  `http://127.0.0.1:32128`. It includes replay/repeat, diagonal/vertical arrows, square-only mode,
  clear, and paused quarter-draw/full/mid-fade/faded inspection controls. Browser visual review
  is recorded by the release task separately.
