# Native ↔ web protocol (stage 3 and later)

The app is a transparent web page (WKWebView, `web/`) on top of a native AR layer (ARKit +
RealityKit, `ios/`). The native layer is deliberately thin: it shows the camera, runs ARKit and
Vision, and draws the boxes it is told to draw. Everything else — hand model, binding, physics,
what is shown — is decided by the page, so it can change without reinstalling the app.

This file is the contract. `ios/ARApp/*.swift` and `web/src/ar.js` / `web/src/fake-native.js`
implement it. Anything not listed here does not exist.

## 0. Conventions

- **World space:** ARKit world, metres, Y up (gravity), right-handed. Matrices are 16 numbers,
  column-major (`m[12], m[13], m[14]` is the translation). Quaternions are `[x, y, z, w]`.
- **Image coordinates** (`x, y` in a hand joint, `rect` in `ar.depth`): normalized 0..1 over the
  camera image **in the sensor's own landscape orientation**, origin top-left, x along the long
  side (1920 px), y down (1440 px). The LiDAR depth map (256×192) and the person mask have the
  same orientation and aspect, so the same normalized point addresses all of them. Depth pixel
  `(u, v)` has its centre at `((u + 0.5) / W, (v + 0.5) / H)`.
- **Unprojecting** an image point with LiDAR depth `z` (metres along the camera's viewing axis,
  as in `sceneDepth`), using the frame's `camera.intrinsics` `[fx,0,0, 0,fy,0, cx,cy,1]` (for the
  full image resolution) and `camera.transform`:
  `px = x·IW, py = y·IH;  local = [(px−cx)/fx·z, −(py−cy)/fy·z, −z];  world = transform · [local, 1]`.
  Checked against the stage-2 captures: floor pixels land at −1.30 m, ARKit's floor plane −1.299 m.
- **Camera axes** (`camera.transform` columns): X = screen down, Y = screen right, Z = backwards
  (the camera looks along −Z). The portrait matrices (`projection`, `view` in `ar.status`) are
  the usual screen-right / screen-up ones.
- **Screen:** `display` = `[a, b, c, d, tx, ty]` (ARKit `displayTransform(for: .portrait,
  viewportSize:)`) maps image (x, y) → view (x', y') = `(a·x + c·y + tx, b·x + d·y + ty)`, in
  0..1 of the viewport; times `viewport` gives CSS pixels. Only the middle ~61 % of the image's
  short side is on screen.
- **Clock:** every native time (`t`, `tv0`, `tv1`, `tSent`, `now`, `frameT`) is seconds on the
  device's uptime clock (the clock of `ARFrame.timestamp` / `CACurrentMediaTime`). The PC's and
  the page's clocks are different and drift: compute latencies only from native times.
- **Blind test:** no message, log line or file name may carry a trial's furniture width.
  (Hand sizes are not blind.)

## 1. Transport (`web/src/native.js`, `ios/ARApp/WebView.swift`)

- web → native: `window.webkit.messageHandlers.native.postMessage({type, id, payload})`.
- native → web reply: `window.__fromNative({id, ...reply})`. A reply with `error` rejects.
  **A message without `id` (or `id: null`) gets no reply** — fire-and-forget for messages sent
  every frame (`postNative()` in native.js).
- native → web event: `window.__nativeEvent({type, ...})`.
- `window.__nativeInfo = {version, buildTime, label, ios, model, features}` before page scripts.
  `features` from stage 3: `["ar", "hands", "groups", "planes", "depth", "haptic", "light"]`.
  Pages check a feature before using it (`hasFeature('hands')`); the stage-2 app has only `"ar"`.

## 2. Session (unchanged from stage 2, with additions)

| message | payload | reply |
|---|---|---|
| `ar.start` | options (below) | `{ok, support, frameSemantics, skippedSemantics, sceneReconstruction, viewport, vision}` |
| `ar.stop` | – | `{ok, wasRunning}` |
| `ar.setOptions` | options that can change while running | `state` |
| `ar.state` | – | `{running, meshOcclusion, personOcclusion, hasFurniture, hands, …}` |
| `ar.raycast` | `{x, y, allowing, alignment}` (x, y: 0..1 of the **screen**) | `{ok, hits: [{position, transform, alignment, plane?}], camera}` |
| `ar.capture` | `{depth, person, image, imageMaxWidth, mesh, meshRadius, hands}` | one frame (below) |

Start options (stage 2): `personSegmentationWithDepth, sceneDepth, smoothedSceneDepth,
sceneReconstruction, horizontalPlanes, verticalPlanes, reset` (fixed for a run) and
`personOcclusion, meshOcclusion, disable[], debug[], statusHz, followAnchor` (changeable).
Added in stage 3 (changeable): `meshReceivesLighting` (bool: virtual lights light the LiDAR mesh
and virtual objects cast shadows on it), `planeEvents` (bool, default true), `planesHz` (default 2),
`hands` (an `ar.hands` config object, applied when the session runs).

`ar.start`'s reply adds `vision: {handPose: bool}`.

`ar.capture` adds, when `hands` is not false (default true): `hands` — Vision run synchronously on
**that** frame, same format as `ar.hands` events' `hands` (with the joint depth samples), plus
`handsConfig`.

## 3. Status event `ar.status` (statusHz, default 4)

Stage 2 fields: `t, tracking, mapping, camera, projection, view, planes{horizontal, vertical},
meshAnchors, hasDepth, person?{fraction, nearest, mean}, furniture?{transform, anchorUpdates,
anchorShift}`. Added:

- `now` — native time when the status was built; `viewport`, `display` (see §0).
- `fps` — ARKit frames per second over the last second.
- `thermal` — `"nominal" | "fair" | "serious" | "critical"`.
- `hands` — `{on, rate (hand events/s), visionMs: [mean, max], hands (count in the last result)}`.
- `latency` — `{n: 0, …}` (all zeros) when there were no samples; from `ar.updateGroups` messages that carried `frameT`: `{n, mean, p50, p90, max}` in
  **milliseconds** of `appliedTime − frameT` over the last second (camera frame captured → box
  update applied on the native side; the screen shows it on the next display frame, ≤ 1 more frame).
- `groups` — `{id: {transform, anchorUpdates, anchorShift}}` for **anchored** groups only.

## 4. Hands

### `ar.hands` (message) — configure hand tracking

Payload (keys absent stay as they are) → reply `{ok, config, available}`:

| key | default | meaning |
|---|---|---|
| `on` | false | run Vision hand pose on camera frames while the session runs |
| `hz` | 30 | at most this many processed frames per second (also bounded by Vision's speed: a frame arriving while one is in flight is skipped) |
| `maxHands` | 2 | `VNDetectHumanHandPoseRequest.maximumHandCount` |
| `orientation` | `"right"` | the `CGImagePropertyOrientation` Vision is told (`"up"`, `"right"`, `"left"`, `"down"`); `"right"` = the picture as seen in portrait |
| `pointTransform` | for the orientation | `[a, b, c, d, tx, ty]`: Vision's normalized point (vx, vy; origin bottom-left, in the oriented picture) → image (x, y) = `(a·vx + c·vy + tx, b·vx + d·vy + ty)`. Defaults: right `[0,-1,-1,0,1,1]`, up `[1,0,0,-1,0,1]`, left `[0,1,1,0,0,0]`, down `[-1,0,0,1,1,0]`. Overridable from the page in case the default is wrong on the device |
| `window` | 2 | joint depth samples use a (2r+1)² window of depth pixels around the joint |
| `minJointConfidence` | 0 | joints below this Vision confidence are still sent with x, y, c, but their six depth fields are 0 (no depth window is read) |
| `patchEvery` | 0 | every N-th hand event also carries a depth patch around each hand (0 = never) |
| `patchMargin` | 12 | patch = bounding box of the hand's joints (confidence > 0.1) in depth pixels, grown by this many pixels, clamped to the map |
| `patchStep` | 1 | take every N-th depth pixel; raised automatically until w·h ≤ `patchMax` |
| `patchMax` | 6000 | |

### `ar.hands` (event) — one processed camera frame

```
{ type: 'ar.hands', seq, t, tv0, tv1, tSent,
  camera: {transform: [16], intrinsics: [9], imageResolution: [1920, 1440]},   // of THIS frame
  display: [6], viewport: [w, h], depthSize: [256, 192] | null, window: r,
  hands: [ { chirality: 'left' | 'right' | 'unknown', confidence,
             joints: [ [x, y, c, dAll, dHand, nHand, nAll, hi, pd] × 21 ] } ],
  patches?: [ {hand, rect: [u0, v0, u1, v1], step, w, h, depth: b64, info: b64} ] }
```

- Sent for every processed frame, also with `hands: []` (the hand left the picture). A frame on
  which Vision fails sends nothing (logged at most every 10 s; `seq` shows the gap).
- A new `orientation` without a `pointTransform` takes that orientation's default transform;
  `pointTransform: null` goes back to the default. An invalid config is refused as a whole
  (`ar.hands`, `ar.setOptions`) — `ar.start` with an invalid `hands` replies `{error: 'hands: …'}`
  before touching the camera.
- **A new page (or a reload) starts with hand tracking off and the default config.** A page's own
  `ar.stop` / `ar.start` keeps its config (processing pauses and resumes). `ar.start` on a running
  session restarts the run: a result in flight is dropped and `seq` starts again at 1.
- `seq` counts processed frames since tracking was turned on; `tv0`/`tv1` = Vision start/end;
  `tSent` = handed to the web view.
- Joint order (Vision names): 0 wrist; 1–4 thumbCMC, thumbMP, thumbIP, thumbTip; 5–8 indexMCP,
  PIP, DIP, Tip; 9–12 middle…; 13–16 ring…; 17–20 little….
- Per joint: `x, y` image coordinates (§0) after `pointTransform`; `c` Vision confidence (0 =
  not found; then x, y mean nothing); then from the depth window around (x, y) (a joint Vision did not find is nine zeros):
  `dAll` median LiDAR depth (m) of valid pixels (0 = none), `dHand` median LiDAR depth of the
  window's **person** pixels (0 = none), `nHand` number of person pixels (valid depth or not), `nAll` valid pixels,
  `hi` fraction of window pixels with LiDAR confidence "high", `pd` median of ARKit's
  person depth (`estimatedDepthData`) over the person pixels (0 = none). Numbers are rounded to
  5 decimals (depth to 0.1 mm).
- Patch: `rect` in depth pixels (u1, v1 exclusive); pixel (i, j) of the patch is depth pixel
  `(u0 + i·step, v0 + j·step)`; `w·h` entries row by row. `depth`: base64 Uint16 little-endian,
  millimetres, 0 = no value. `info`: base64 Uint8, bits 0–1 = LiDAR confidence (0 low, 1 medium,
  2 high), bit 2 = person.

## 5. Groups of boxes

Everything the page shows in the 3D picture (hand model, furniture, debug markers) is a group of
boxes. A group has its own pose; each box has a pose inside the group, a size and a look.
Updating poses every frame does not rebuild meshes.

| message | payload | reply |
|---|---|---|
| `ar.setGroup` | `{id, boxes: [box], position?, rotation? \| yaw?, anchored?: false, shadow?: false, visible?: true}` — creates or replaces | `{ok, count}` |
| `ar.updateGroups` | `{groups: [{id, position?, rotation? \| yaw?, visible?, boxes?: [update]}], frameT?}` | `{ok, now}` (only if sent with an id) |
| `ar.moveGroup` | `{id, dx?, dy?, dz?, dyaw?}` — **relative to the group's current pose, after ARKit's corrections**; dx/dy/dz along the group's own axes, then turn by dyaw about world Y | `{ok, transform}` |
| `ar.removeGroup` | `{id}` | `{ok}` |
| `ar.clearGroups` | – | `{ok}` |
| `ar.groups` | – | `{ok, groups: {id: {transform, anchored, count, visible}}}` |

- `box` = `{size: [w, h, d], position: [x, y, z], rotation?: [qx, qy, qz, qw], color?: [r, g, b]
  (0..1 sRGB), opacity?: 1, material?: 'pbr' | 'unlit' | 'occlusion', roughness?: 0.8,
  metallic?: 0, style?: 'solid' | 'edges', edge?: 0.003, visible?: true}`. `'occlusion'` draws
  nothing but hides virtual things behind it (shows the camera picture). `'edges'` draws the 12
  edges as thin bars `edge` metres thick.
- `update` = `[i, px, py, pz, qx, qy, qz, qw]` or `[i, px, py, pz, qx, qy, qz, qw, sx, sy, sz]`
  (fast path: pose and optionally size of box `i`), or `{i, position?, rotation?, size?, color?,
  opacity?, material?, style?, visible?}`.
- `anchored: true` puts an ARKit anchor at the group's pose; when ARKit corrects its map the
  group follows the real surroundings and `ar.status.groups[id]` reports where it is now. Use
  `ar.moveGroup` for nudges so a correction is not undone. Setting an absolute pose re-anchors.
- `shadow: true` = RealityKit grounding shadow under the group's boxes.
- `dyaw` in `ar.moveGroup` turns about the vertical axis through the group's own origin (its
  position does not change). A group update with both `rotation` and `yaw` uses `rotation`. Box
  object updates also accept `roughness`, `metallic`, `edge`.
- **Per-frame poses go to unanchored groups** (the hand). An absolute pose on an anchored group
  re-anchors, i.e. creates and removes an ARKit anchor.
- `ar.updateGroups` sent with an id: invalid parts are skipped, the valid ones applied, and the
  reply is `{error: 'N update(s) skipped: …'}`; without an id problems are only logged (at most
  every 5 s). Before the first `ar.start` after the app launched, `ar.setGroup` / `ar.setFurniture`
  reply `{error: 'ar-not-started'}`; the other group messages simply see no groups.
- **`ar.start` with reset (the default) and `ar.stop` remove all groups (and `ar.stop` the
  light).** Create groups after `ar.start` has resolved. `ar.clearGroups` removes "furniture"
  too; `ar.removeGroup` of an unknown id replies `{ok}`.
- The stage-2 messages still work and are a group with id `"furniture"` (anchored):
  `ar.setFurniture {boxes, position, yaw, shadow}`, `ar.moveFurniture {position, yaw}`,
  `ar.clearFurniture`. `ar.status.furniture` is still sent.
- At most 64 groups, 400 boxes per group; violations reply `{error}`.

## 6. Planes

- Event `ar.planes` `{planes: [plane]}` — the full list, sent when planes are added / updated /
  removed, at most `planesHz` times a second (if `planeEvents`).
- Message `ar.planes` → `{ok, planes}`.
- `plane` = `{id, alignment: 'horizontal' | 'vertical', class: 'floor' | 'table' | 'wall' |
  'ceiling' | 'seat' | 'window' | 'door' | 'none', transform: [16], center: [3], extent: [w, l],
  rotationOnYAxis, boundary: [[x, z], …]}` — `center` and `boundary` in the plane's own space
  (y = 0 on the plane), at most 128 boundary points.

## 7. Depth on request

`ar.depth` `{rect?: [x0, y0, x1, y1] (image coordinates, default whole map), step?: 2,
personDepth?: false}` → `{ok, t, camera, display, viewport, depthSize, rect: [u0, v0, u1, v1],
step, w, h, depth: b64, info: b64, personDepth?: b64}` — same encodings as a hand patch
(`personDepth` Uint16 mm). At most 49 152 pixels: a larger request gets a bigger `step` (the reply
carries the step used). Without a LiDAR map: `{error: 'no-depth'}`.

## 8. Light

`ar.setLight` `{on, direction?: [x, y, z] (the way the light travels, default [0.3, -1, -0.2]),
intensity?: 2000 (lux), shadow?: true, shadowDistance?: 2, color?: [r, g, b]}` → `{ok}`. A
directional light; `on` defaults to true, `on: false` removes it. With `shadow`, virtual objects cast shadows on each other, and on the real
world when `meshReceivesLighting` is on.

## 9. Haptics (works without AR)

`haptic` `{kind?: 'impact' | 'selection' | 'success' | 'warning' | 'error', style?: 'light' |
'medium' | 'heavy' | 'soft' | 'rigid', intensity?: 1}` → `{ok}`.
