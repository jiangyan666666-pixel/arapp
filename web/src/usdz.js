// 1:1 furniture → USDZ bytes for iPhone AR Quick Look. Runs in the browser
// (iphone.html builds each hidden-width model on the phone) and in Node
// (tools/make_usdz.mjs). Plain-coloured materials only: textures would need a canvas.
//
// Placement:
//   - default: plane anchoring (Quick Look puts it on the floor, you drag it into place)
//   - marker:  image anchoring – the model appears on a printed marker (public/ar/marker.png,
//     see marker.html). The marker lies flat on the floor at the centre of the gap; the
//     model's bottom centre sits on the marker centre, front towards the marker's bottom edge.
//     Syntax: developer.apple.com/documentation/usd/placing-a-prim-in-the-real-world

import * as THREE from 'three';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'three/addons/libs/fflate.module.js';
import { buildFurnitureGroup } from './furniture.js';

/**
 * @param {string} modelId
 * @param {number} widthMetres outer width
 * @param {{marker?: {png: Uint8Array, physicalWidth: number}}} [opts]
 *   physicalWidth is written verbatim: Apple's docs disagree whether it is centimetres or metres.
 * @returns {Promise<{data: Uint8Array, size: {x: number, y: number, z: number}}>} size in metres
 */
export async function furnitureUSDZ(modelId, widthMetres, opts = {}) {
  const scene = new THREE.Scene();
  scene.add(buildFurnitureGroup(modelId, widthMetres));
  scene.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3());
  const exporter = new USDZExporter();
  let data = exporter.parseAsync
    ? await exporter.parseAsync(scene)
    : await new Promise((resolve, reject) => exporter.parse(scene, resolve, reject));
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  if (opts.marker) data = withImageAnchor(data, opts.marker.png, opts.marker.physicalWidth);
  return { data, size: { x: size.x, y: size.y, z: size.z } };
}

const PLANE_ANCHOR = /^(\s*)token preliminary:anchoring:type = "plane"\r?\n\s*token preliminary:planeAnchoring:alignment = "horizontal"\r?\n/m;
const SCENE_META = /(def Xform "Scene" \(\r?\n)/;

/** Swap the exporter's plane anchoring for an image anchor and pack the marker image. */
export function withImageAnchor(usdz, png, physicalWidth) {
  const files = unzipSync(usdz);
  let usda = strFromU8(files['model.usda']);
  const m = usda.match(PLANE_ANCHOR);
  if (!m || !SCENE_META.test(usda)) throw new Error('unexpected USDA layout from USDZExporter');
  const ind = m[1];
  usda = usda.replace(
    PLANE_ANCHOR,
    `${ind}uniform token preliminary:anchoring:type = "image"\n` +
      `${ind}rel preliminary:imageAnchoring:referenceImage = </Root/Scenes/Scene/ImageReference>\n\n` +
      `${ind}def Preliminary_ReferenceImage "ImageReference"\n${ind}{\n` +
      `${ind}\tuniform asset image = @marker.png@\n` +
      `${ind}\tuniform double physicalWidth = ${physicalWidth}\n${ind}}\n`,
  );
  usda = usda.replace(SCENE_META, `$1\t\t\tprepend apiSchemas = ["Preliminary_AnchoringAPI"]\n`);

  // model.usda must stay the first file; the image goes last.
  const ordered = { 'model.usda': strToU8(usda) };
  for (const [name, bytes] of Object.entries(files)) if (name !== 'model.usda') ordered[name] = bytes;
  ordered['marker.png'] = png;
  return zipAligned(ordered);
}

// USDZ: stored (no compression) and every file's data 64-byte aligned.
// Same padding trick as three's USDZExporter (fflate issue #39).
function zipAligned(files) {
  const out = {};
  let offset = 0;
  for (const [name, file] of Object.entries(files)) {
    offset += 34 + name.length;
    const mod = offset & 63;
    out[name] = mod !== 4 ? [file, { extra: { 12345: new Uint8Array(64 - mod) } }] : file;
    offset = file.length;
  }
  return zipSync(out, { level: 0, mtime: new Date('2026-01-01T00:00:00Z') });
}
