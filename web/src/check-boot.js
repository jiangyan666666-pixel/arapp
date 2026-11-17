// Starts the on-device check of the current stage (3). On the PC, check.html?fake (or ?fake=desk,
// ?fake=room, or ?replay=<recording>) puts a pretend native layer in place first (fake-native.js),
// so the page's own logic can be run through without the phone.
const q = new URLSearchParams(location.search);
if (q.has('fake') || q.has('replay')) {
  await import('./fake-native.js');
}
await import('./check3.js');
