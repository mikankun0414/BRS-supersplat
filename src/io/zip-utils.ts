// PKWARE APPNOTE 6.3.10: all ZIP64 integers are little endian unsigned u64.
// Browser range APIs use Numbers, so reject values beyond exact integer range.
const ZIP32_MAX = 0xffffffff;
const safeSize = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('ZIP size/offset exceeds safe integer range');
    return value;
};
const get64 = (view: DataView, offset: number): number => safeSize(Number(view.getBigUint64(offset, true)));
const put64 = (view: DataView, offset: number, value: number): void => view.setBigUint64(offset, BigInt(safeSize(value)), true);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});
const updateCrc = (crc: number, bytes: Uint8Array): number => {
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return crc >>> 0;
};
export { ZIP32_MAX, safeSize, get64, put64, updateCrc };
