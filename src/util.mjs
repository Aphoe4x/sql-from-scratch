// Small shared helpers.

/** CRC-32 (IEEE 802.3 polynomial), table-driven, Node-style unsigned ints. */
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}
export function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pollUntil = async (fn, timeoutMs = 15000, intervalMs = 15) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return false;
};
