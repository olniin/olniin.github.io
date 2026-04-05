// New 2026 binary protocol
// Header: 8 bytes = 0F A6 0F A6 0F A6 0F A6
// Then: 2048 bytes of ADC data = 1024 samples * (2 bytes ADC1 + 2 bytes ADC2)

export const NUM_SAMPLES = 1024;

const HEADER = Uint8Array.from([
  0x0F, 0xA6, 0x0F, 0xA6, 0x0F, 0xA6, 0x0F, 0xA6
]);

export function parseIscLine(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    return { ok: false, reason: "Input must be Uint8Array" };
  }

  if (buffer.length !== 8 + 2048) {
    return { ok: false, reason: `Wrong length: ${buffer.length}` };
  }

  // --- 1. CHECK HEADER ---
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== HEADER[i]) {
      return { ok: false, reason: "Invalid header" };
    }
  }

  // --- 2. PREPARE OUTPUT ---
  const s1 = new Int16Array(NUM_SAMPLES);
  const s2 = new Int16Array(NUM_SAMPLES);

  let clip1 = false;
  let clip2 = false;

  // New protocol likely does NOT include zero calibration → use 0
  const center1 = 2047;
  const center2 = 2047;

  // --- 3. PARSE SAMPLES ---
  // Data starts at offset 8
  let offset = 8;

  for (let i = 0; i < NUM_SAMPLES; i++) {
    // Read 16-bit little-endian values for ADC1 and ADC2
    const raw1 = buffer[offset] | (buffer[offset + 1] << 8);
    const raw2 = buffer[offset + 2] | (buffer[offset + 3] << 8);

    offset += 4;

    // Detect clipping
    if (raw1 > 4000 || raw1 === 0) clip1 = true;
    if (raw2 > 4000 || raw2 === 0) clip2 = true;

    // Convert to signed centered output (same as old logic)
    s1[i] = raw1 - center1;
    s2[i] = raw2 - center2;
  }

  // --- 4. RETURN STRUCTURE (similar to old parser) ---
  return {
    ok: true,
    s1,
    s2,
    clip1,
    clip2,

    // Old protocol had these values; new does not.
    // Return defaults so the front-end does not break.
    z1: 0,
    z2: 0,
    cal1: 0,
    cal2: 0,
    chkA: null,
    chkB: null,
    chkOk: null
  };
}
