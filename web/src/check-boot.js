// Starts the on-device check. On the PC, check.html?fake puts a pretend native layer in place
// first (fake-native.js), so the page's own logic can be run through without the phone.
if (new URLSearchParams(location.search).has('fake')) {
  await import('./fake-native.js');
}
await import('./check.js');
