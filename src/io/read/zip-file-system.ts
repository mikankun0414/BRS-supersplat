import { ReadStream, type ReadFileSystem, type ReadSource } from '@playcanvas/splat-transform';

import { ZIP32_MAX, get64, safeSize, updateCrc } from '../zip-utils';

type Entry = { name: string; size: number; compressed: number; offset: number; crc: number; flags: number; method: number };
const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

class EntryStream extends ReadStream {
    private crc = 0xffffffff;
    private closed = false;

    constructor(private inner: ReadStream, size: number, private expectedCrc?: number) {
        super(size);
    }

    async pull(target: Uint8Array): Promise<number> {
        if (this.closed || !target.length) return 0;
        const remaining = this.expectedSize! - this.bytesRead;
        if (remaining === 0) {
            if (this.expectedCrc !== undefined && ((this.crc ^ 0xffffffff) >>> 0) !== this.expectedCrc) throw new Error('ZIP entry CRC mismatch');
            if (await this.inner.pull(new Uint8Array(1))) throw new Error('ZIP entry exceeds declared size');
            this.close();
            return 0;
        }
        const n = await this.inner.pull(target.subarray(0, remaining));
        if (!n) throw new Error('Truncated ZIP entry');
        this.bytesRead += n;
        if (this.expectedCrc !== undefined) {
            this.crc = updateCrc(this.crc, target.subarray(0, n));
            if (this.bytesRead === this.expectedSize && ((this.crc ^ 0xffffffff) >>> 0) !== this.expectedCrc) {
                throw new Error('ZIP entry CRC mismatch');
            }
        }
        return n;
    }

    close(): void {
        this.closed = true; this.inner.close();
    }
}

class InflateStream extends ReadStream {
    private reader: ReadableStreamDefaultReader<Uint8Array>;
    private pending: Uint8Array = new Uint8Array(0);

    constructor(private inner: ReadStream, size: number) {
        super(size);
        const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
            async pull(controller) {
                const bytes = new Uint8Array(65536);
                const n = await inner.pull(bytes);
                if (n) controller.enqueue(bytes.subarray(0, n));
                else controller.close();
            },
            cancel: () => inner.close()
        });
        this.reader = input.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    }

    async pull(target: Uint8Array): Promise<number> {
        if (!target.length) return 0;
        while (!this.pending.length) {
            const result = await this.reader.read();
            if (result.done) return 0;
            this.pending = result.value;
        }
        const n = Math.min(target.length, this.pending.length);
        target.set(this.pending.subarray(0, n));
        this.pending = this.pending.subarray(n);
        this.bytesRead += n;
        return n;
    }

    close(): void {
        this.reader.cancel().catch(() => {}); this.inner.close();
    }
}

// Range-based ZIP32/ZIP64 reader. Only metadata and requested entry ranges are
// read; the archive is never materialized. Stored entries stay seekable for PLY.
class ZipReadFileSystem implements ReadFileSystem {
    private directory: Promise<Map<string, Entry>> | null = null;
    private closed = false;
    private dataEnd = 0;

    constructor(private source: ReadSource) {}

    private async bytes(start: number, length: number): Promise<Uint8Array> {
        const end = safeSize(start + length);
        if (this.closed || safeSize(start) > this.source.size! || end > this.source.size!) throw new Error('ZIP range out of bounds');
        const stream = this.source.read(start, end);
        const result = new Uint8Array(length);
        let at = 0;
        try {
            while (at < length) {
                const n = await stream.pull(result.subarray(at));
                if (!n) throw new Error('Truncated ZIP metadata');
                at += n;
            }
            return result;
        } finally {
            stream.close();
        }
    }

    private async parse(): Promise<Map<string, Entry>> {
        const size = safeSize(this.source.size ?? NaN);
        const tailStart = Math.max(0, size - 65557);
        const tail = await this.bytes(tailStart, size - tailStart);
        const t = viewOf(tail);
        let end = tail.length - 22;
        for (; end >= 0; end--) {
            if (t.getUint32(end, true) === 0x06054b50 && end + 22 + t.getUint16(end + 20, true) === tail.length) break;
        }
        if (end < 0) throw new Error('ZIP end record missing');
        const eocd = tailStart + end;
        if (t.getUint16(end + 4, true) || t.getUint16(end + 6, true)) throw new Error('Split ZIP archives are unsupported');
        let count = t.getUint16(end + 10, true);
        let cdSize = t.getUint32(end + 12, true);
        let cdOffset = t.getUint32(end + 16, true);
        let limit = eocd;
        if (count === 65535 || cdSize === ZIP32_MAX || cdOffset === ZIP32_MAX) {
            const locator = viewOf(await this.bytes(eocd - 20, 20));
            if (locator.getUint32(0, true) !== 0x07064b50 || locator.getUint32(4, true) || locator.getUint32(16, true) !== 1) throw new Error('Invalid ZIP64 locator');
            limit = get64(locator, 8);
            const record = viewOf(await this.bytes(limit, 56));
            if (record.getUint32(0, true) !== 0x06064b50 || get64(record, 4) < 44 || safeSize(limit + 12 + get64(record, 4)) !== eocd - 20 || record.getUint32(16, true) || record.getUint32(20, true)) throw new Error('Invalid ZIP64 end record');
            count = get64(record, 32);
            if (get64(record, 24) !== count) throw new Error('Split ZIP archives are unsupported');
            cdSize = get64(record, 40);
            cdOffset = get64(record, 48);
        } else if (t.getUint16(end + 8, true) !== count) throw new Error('Split ZIP archives are unsupported');
        if (safeSize(cdOffset + cdSize) > limit || count > Math.floor(cdSize / 46)) throw new Error('Invalid ZIP central directory bounds');
        this.dataEnd = cdOffset;
        const entries = new Map<string, Entry>();
        let at = cdOffset;
        for (let i = 0; i < count; i++) {
            if (at + 46 > cdOffset + cdSize) throw new Error('Truncated ZIP directory');
            const h = viewOf(await this.bytes(at, 46));
            if (h.getUint32(0, true) !== 0x02014b50) throw new Error('Invalid ZIP directory signature');
            const flags = h.getUint16(8, true);
            const method = h.getUint16(10, true);
            if ((flags & ~0x80e) || (method !== 0 && method !== 8)) throw new Error('Unsupported ZIP encryption, flags or compression');
            const nameLength = h.getUint16(28, true);
            const extraLength = h.getUint16(30, true);
            const next = at + 46 + nameLength + extraLength + h.getUint16(32, true);
            if (next > cdOffset + cdSize || h.getUint16(34, true)) throw new Error('Invalid ZIP directory entry');
            const variable = await this.bytes(at + 46, nameLength + extraLength);
            const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'ascii').decode(variable.subarray(0, nameLength));
            let compressed = h.getUint32(20, true);
            let uncompressed = h.getUint32(24, true);
            let offset = h.getUint32(42, true);
            let zip64 = false;
            const extra = viewOf(variable.subarray(nameLength));
            for (let x = 0; x < extraLength;) {
                if (x + 4 > extraLength) throw new Error('Truncated ZIP extra field');
                const tag = extra.getUint16(x, true);
                const length = extra.getUint16(x + 2, true);
                const stop = x + 4 + length;
                if (stop > extraLength) throw new Error('Truncated ZIP extra field');
                if (tag === 1) {
                    zip64 = true;
                    let p = x + 4;
                    const take = () => {
                        if (p + 8 > stop) throw new Error('Truncated ZIP64 extra'); const value = get64(extra, p); p += 8; return value;
                    };
                    if (uncompressed === ZIP32_MAX) uncompressed = take();
                    if (compressed === ZIP32_MAX) compressed = take();
                    if (offset === ZIP32_MAX) offset = take();
                }
                x = stop;
            }
            if (!zip64 && (uncompressed === ZIP32_MAX || compressed === ZIP32_MAX || offset === ZIP32_MAX)) throw new Error('ZIP64 extra field missing');
            if (method === 0 && compressed !== uncompressed) throw new Error('Invalid stored ZIP size');
            if (entries.has(name)) throw new Error('Duplicate ZIP entry');
            entries.set(name, { name, size: uncompressed, compressed, offset, crc: h.getUint32(16, true), flags, method });
            at = next;
        }
        if (at !== cdOffset + cdSize) throw new Error('ZIP directory size mismatch');
        return entries;
    }

    private entries(): Promise<Map<string, Entry>> {
        if (this.closed) throw new Error('ZIP source is closed');
        this.directory ??= this.parse();
        return this.directory;
    }

    async list(): Promise<string[]> {
        return Array.from((await this.entries()).keys());
    }

    async createSource(filename: string): Promise<ReadSource> {
        const entry = (await this.entries()).get(filename);
        if (!entry) throw new Error(`ZIP entry not found: ${filename}`);
        const h = viewOf(await this.bytes(entry.offset, 30));
        if (h.getUint32(0, true) !== 0x04034b50 || h.getUint16(6, true) !== entry.flags || h.getUint16(8, true) !== entry.method) throw new Error('Invalid ZIP local header');
        const nameLength = h.getUint16(26, true);
        const extraLength = h.getUint16(28, true);
        const dataOffset = safeSize(entry.offset + 30 + nameLength + extraLength);
        const dataEnd = safeSize(dataOffset + entry.compressed);
        if (dataEnd > this.dataEnd) throw new Error('ZIP entry out of bounds');
        const variable = await this.bytes(entry.offset + 30, nameLength + extraLength);
        if (new TextDecoder(entry.flags & 0x800 ? 'utf-8' : 'ascii').decode(variable.subarray(0, nameLength)) !== entry.name) throw new Error('ZIP filename mismatch');
        let localSize = h.getUint32(22, true);
        let localCompressed = h.getUint32(18, true);
        let wide = false;
        const extra = viewOf(variable.subarray(nameLength));
        for (let at = 0; at < extraLength;) {
            if (at + 4 > extraLength) throw new Error('Truncated ZIP local extra');
            const tag = extra.getUint16(at, true);
            const length = extra.getUint16(at + 2, true);
            if (at + 4 + length > extraLength) throw new Error('Truncated ZIP local extra');
            if (tag === 1) {
                if (wide || length < 16) throw new Error('Invalid ZIP64 local extra');
                wide = true;
                localSize = get64(extra, at + 4);
                localCompressed = get64(extra, at + 12);
            }
            at += 4 + length;
        }
        if (!wide && (localSize === ZIP32_MAX || localCompressed === ZIP32_MAX)) throw new Error('ZIP64 local extra missing');
        if (entry.flags & 8) {
            const first = viewOf(await this.bytes(dataEnd, 4));
            // The optional signature can also equal an unsigned descriptor's
            // CRC, so try both interpretations before rejecting the entry.
            let valid = false;
            for (const skip of first.getUint32(0, true) === 0x08074b50 ? [4, 0] : [0]) {
                const length = skip + (wide ? 20 : 12);
                if (dataEnd + length > this.dataEnd) continue;
                const d = viewOf(await this.bytes(dataEnd, length));
                if (d.getUint32(skip, true) === entry.crc && (wide ? get64(d, skip + 4) : d.getUint32(skip + 4, true)) === entry.compressed && (wide ? get64(d, skip + 12) : d.getUint32(skip + 8, true)) === entry.size) {
                    valid = true;
                    break;
                }
            }
            if (!valid) throw new Error('ZIP descriptor mismatch or truncation');
        } else if (h.getUint32(14, true) !== entry.crc || localSize !== entry.size || localCompressed !== entry.compressed) throw new Error('ZIP local size/CRC metadata mismatch');
        let closed = false;
        return {
            size: entry.size,
            seekable: entry.method === 0,
            read: (start = 0, end = entry.size) => {
                if (closed || this.closed) throw new Error('ZIP source is closed');
                safeSize(start); safeSize(end);
                if (end < start || end > entry.size || (entry.method === 8 && (start !== 0 || end !== entry.size))) throw new Error('Invalid ZIP entry range');
                const inner = entry.method === 0 ? this.source.read(dataOffset + start, dataOffset + end) : new InflateStream(this.source.read(dataOffset, dataEnd), entry.size);
                return new EntryStream(inner, end - start, start === 0 && end === entry.size ? entry.crc : undefined);
            },
            close: () => {
                closed = true;
            }
        };
    }

    close(): void {
        this.closed = true; this.source.close();
    }
}

export { ZipReadFileSystem };
