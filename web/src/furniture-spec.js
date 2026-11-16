// The furniture as plain numbers: a list of boxes at an exact outer width. One source for
// both renderers – three.js (furniture.js → USDZ) and the native AR layer, which draws exactly
// the boxes the page sends it (ios/ARApp/ARController.swift). No three.js import here.
//
// Metres. Origin at the bottom centre, front facing +Z, Y up.
// BLIND TEST: the width is the hidden variable of a trial – never log or show these numbers.

export const MODELS = [
  { id: 'shelf', label: '书架（高 180 · 深 30）', kind: 'procedural', height: 1.8, depth: 0.3 },
  { id: 'sideboard', label: '矮柜（高 80 · 深 40）', kind: 'procedural', height: 0.8, depth: 0.4 },
  // A CC0 glTF goes here (Poly Haven / Sketchfab CC0). Put the file in public/models/.
  // { id: 'ph-shelf', label: 'Poly Haven 书架', kind: 'gltf', url: '/models/shelf.glb', nominalWidth: 0.8 },
];

/** sRGB hex per material name. */
export const COLORS = { wood: 0xb08968, dark: 0x6e4b2a };
export const ROUGHNESS = { wood: 0.8, dark: 0.85 };

const box = (size, position, material) => ({ size, position, material });

function shelfBoxes(w, { height: h, depth: d }) {
  const t = 0.018;
  const out = [
    box([t, h, d], [-(w - t) / 2, h / 2, 0], 'wood'), // left side
    box([t, h, d], [(w - t) / 2, h / 2, 0], 'wood'), // right side
    box([w - 2 * t, t, d], [0, h - t / 2, 0], 'wood'), // top
    box([w - 2 * t, t, d], [0, 0.06 + t / 2, 0], 'wood'), // bottom
    box([w - 2 * t, 0.06, d - 0.04], [0, 0.03, -0.02], 'dark'), // plinth
    box([w - 2 * t, h - 2 * t, 0.006], [0, h / 2, -d / 2 + 0.003], 'dark'), // back
  ];
  const nShelves = Math.max(1, Math.round(h / 0.38) - 1);
  const y0 = 0.06 + t;
  const y1 = h - t;
  for (let i = 1; i <= nShelves; i++) {
    out.push(box([w - 2 * t, t, d - 0.012], [0, y0 + ((y1 - y0) * i) / (nShelves + 1), 0.006], 'wood'));
  }
  return out;
}

function sideboardBoxes(w, { height: h, depth: d }) {
  // outer width is exactly w (the hidden trial width): the top is the widest part
  const out = [
    box([w - 0.02, h - 0.08, d - 0.02], [0, 0.08 + (h - 0.08) / 2, -0.01], 'wood'), // carcass
    box([w, 0.02, d], [0, h - 0.01, 0], 'dark'), // top
  ];
  for (const sx of [-1, 1]) {
    out.push(box([w / 2 - 0.03, h - 0.14, 0.012], [(sx * w) / 4, 0.08 + (h - 0.08) / 2, d / 2 - 0.006], 'dark')); // door
    out.push(box([0.03, 0.08, 0.03], [sx * (w / 2 - 0.04), 0.04, d / 2 - 0.04], 'dark')); // front leg
    out.push(box([0.03, 0.08, 0.03], [sx * (w / 2 - 0.04), 0.04, -d / 2 + 0.04], 'dark')); // back leg
  }
  return out;
}

const BUILDERS = { shelf: shelfBoxes, sideboard: sideboardBoxes };

/**
 * @param {string} modelId 'shelf' | 'sideboard'
 * @param {number} width outer width in metres
 * @returns {{size: number[], position: number[], material: 'wood'|'dark'}[]}
 */
export function furnitureBoxes(modelId, width) {
  const model = MODELS.find((m) => m.id === modelId && m.kind === 'procedural');
  if (!model) throw new Error(`no procedural model "${modelId}"`);
  return BUILDERS[model.id](width, model);
}

/** The same boxes in the form the native layer takes: colour as [r, g, b] in 0..1 (sRGB). */
export function furnitureBoxesForNative(modelId, width) {
  return furnitureBoxes(modelId, width).map((b) => {
    const hex = COLORS[b.material];
    return {
      size: b.size,
      position: b.position,
      color: [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255],
      roughness: ROUGHNESS[b.material],
    };
  });
}

/** Outer size in metres of the model at this width. */
export function furnitureSize(modelId, width) {
  const model = MODELS.find((m) => m.id === modelId);
  return { width, height: model.height, depth: model.depth };
}
