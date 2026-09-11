# Cursor feedback — 2026-09-11

Feedback belongs to the cursor artwork. A short continuous ribbon follows its rear; pressing
compresses the artwork and warms its existing contour, and releasing gently settles the scale
and fades that contour. There are no detached rings, tip markers, or sparks. The cursor's parent
keeps the exact input translation while its SVG artwork animates independently.

The ribbon uses three aligned tapered SVG paths with smooth quadratic joins: a restrained warm
core and a soft outer edge. It retains at most ten dispatched points and 32 px of path length,
using one reusable SVG layer. Movement restarts a 160 ms native opacity fade; stationary updates
and jumps over 64 px produce no trail. Press and release scale animations run for 125/210 ms,
with the release contour fading over 280 ms. Held samples do not replay them. No additional
pointer events, sampling timers, or RAF loops were introduced.

Hide cancels effects, removes their layer, and clears movement history. Reduced motion disables
the animations and trail while retaining a static held-button cue. The physical input shield,
native `not-allowed` cursor, two-pixel input aperture, and smooth motor path remain unchanged.

Validation: all 15 focused page-cursor tests passed, including continuous bounded ribbon
geometry, pooled nodes, stationary/held deduplication, artwork-only transitions, exact parent
coordinates, completion cleanup, jump/reset handling, reduced motion, aperture sealing, and
suppression teardown. The release task runs the complete repository gate separately.

Native Chrome review used `/tmp/sliced-cursor-feedback-fixture.html`, served at
`http://127.0.0.1:32129`. The fixture has light/dark checkerboard regions, normal 32 px cursor
canvases, and no target dots. Trail, press, and release were inspected on both square colors at
actual size. The rear ribbon remained short and continuous; the warm contour stayed on the
artwork and remained restrained on both backgrounds. The inspected press scale was 0.9317 and
release scale 1.0062, with the parent translation unchanged. Still controls pause feedback only,
keeping cursor entrance visibility intact. A complete replay left zero SVGs and zero fixed
cursor/shield layers; the browser reported no console errors. Escape also restores physical
input.
