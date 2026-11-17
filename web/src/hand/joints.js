// The 21 hand joints as the native layer sends them (docs/protocol.md §4, Vision's order) and
// the 16 boxes of the hand model built on them. Pure data, no DOM: the page and the Node tools
// (tools/hand_test.mjs, tools/hand_replay.mjs) share it.
//
// API
//   JOINT_NAMES            21 names in protocol order (0 wrist, 1-4 thumb, 5-8 index, ...)
//   J                      name -> index, e.g. J.indexMCP === 5
//   FIELD                  index of each number in a joint row of an 'ar.hands' event:
//                          {x:0, y:1, c:2, dAll:3, dHand:4, nHand:5, nAll:6, hi:7, pd:8}
//   FINGERS                ['thumb', 'index', 'middle', 'ring', 'little']
//   CHAIN                  finger -> its 4 joint indices, base first (thumb: CMC, MP, IP, Tip;
//                          the others: MCP, PIP, DIP, Tip)
//   PALM_JOINTS            [0, 1, 5, 9, 13, 17] = wrist, thumbCMC, index..little MCP. The order
//                          of model.palmShape.
//   SEGMENTS               16 entries; the index is the box index in the native hand group.
//                          0 = {id: 'palm'}; then per finger (FINGERS order) three
//                          {id: '<finger>1'..'<finger>3', finger, from, to} (joint indices).
//   SEGMENT_OF             finger -> [3 box indices]

export const JOINT_NAMES = [
  'wrist',
  'thumbCMC', 'thumbMP', 'thumbIP', 'thumbTip',
  'indexMCP', 'indexPIP', 'indexDIP', 'indexTip',
  'middleMCP', 'middlePIP', 'middleDIP', 'middleTip',
  'ringMCP', 'ringPIP', 'ringDIP', 'ringTip',
  'littleMCP', 'littlePIP', 'littleDIP', 'littleTip',
];

export const J = Object.freeze(Object.fromEntries(JOINT_NAMES.map((n, i) => [n, i])));

export const FIELD = Object.freeze({ x: 0, y: 1, c: 2, dAll: 3, dHand: 4, nHand: 5, nAll: 6, hi: 7, pd: 8 });

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];

export const CHAIN = Object.freeze({
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  little: [17, 18, 19, 20],
});

export const PALM_JOINTS = [0, 1, 5, 9, 13, 17];

export const SEGMENTS = [{ id: 'palm' }];
for (const finger of FINGERS) {
  const c = CHAIN[finger];
  for (let s = 0; s < 3; s++) SEGMENTS.push({ id: `${finger}${s + 1}`, finger, from: c[s], to: c[s + 1] });
}

export const SEGMENT_OF = Object.freeze(Object.fromEntries(FINGERS.map((f, k) => [f, [1 + 3 * k, 2 + 3 * k, 3 + 3 * k]])));
