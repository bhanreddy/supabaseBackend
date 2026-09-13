// PEM line breaks are forbidden in HTTP header values. The mobile client
// transports them as literal backslash-n pairs, preserving the stored key bytes.
export function readStaffDevicePublicKey(headers) {
  const value = headers['x-device-session-key'] || headers['x-device-public-key'];
  return typeof value === 'string' ? value.replace(/\\n/g, '\n') : null;
}
