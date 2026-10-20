import type { FileSystem, Writer } from '@playcanvas/splat-transform';

import { ZIP32_MAX, put64, safeSize, updateCrc } from '../zip-utils';

type Entry = { name: Uint8Array; offset: number; size: number; crc: number };

// Store-only, sequential streaming ZIP. Unknown entry sizes reserve ZIP64 in
// the local header before emitting any data (APPNOTE 4.3.9, 4.5.3). Small central
// directories remain classic, including sizes, for existing project readers.
class ZipFileSystem implements FileSystem {
    private entries: Entry[] = [];
    private active: Writer | null = null;
    private names = new Set<string>();
    private offset = 0;
    private stopped = false;

    constructor(private writer: Writer) {}

    private async emit(bytes: Uint8Array): Promise<void> {
        if (this.stopped) throw new Error('ZIP writer is closed');
        const next = safeSize(this.offset + bytes.length);
        try {
            await this.writer.write(bytes);
            this.offset = next;
        } catch (error) {
            await this.abort().catch(() => {});
            throw error;
        }
    }

    async createWriter(filename: string): Promise<Writer> {
        if (this.active) await this.active.close();
        if (this.stopped) throw new Error('ZIP writer is closed');
        const name = new TextEncoder().encode(filename);
        if (!name.length || name.length > 65535 || this.names.has(filename)) {
            throw new Error('Invalid or duplicate ZIP filename');
        }
        const entry: Entry = { name, offset: this.offset, size: 0, crc: 0xffffffff };
        const header = new Uint8Array(30 + name.length + 20);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 45, true);
        view.setUint16(6, 0x808, true);
        view.setUint16(12, 33, true); // 1980-01-01
        view.setUint32(18, ZIP32_MAX, true);
        view.setUint32(22, ZIP32_MAX, true);
        view.setUint16(26, name.length, true);
        view.setUint16(28, 20, true);
        header.set(name, 30);
        view.setUint16(30 + name.length, 1, true);
        view.setUint16(32 + name.length, 16, true);
        await this.emit(header);
        this.entries.push(entry);
        this.names.add(filename);
        let closed = false;
        // Object methods expose Writer's byte counter; capture the owning FS.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const owner = this;
        const result: Writer = {
            get bytesWritten() {
                return entry.size;
            },
            async write(bytes) {
                if (closed || owner.stopped) throw new Error('ZIP entry is closed');
                const size = safeSize(entry.size + bytes.length);
                await owner.emit(bytes);
                entry.crc = updateCrc(entry.crc, bytes);
                entry.size = size;
            },
            async close() {
                if (closed) return;
                closed = true;
                const descriptor = new Uint8Array(24);
                const v = new DataView(descriptor.buffer);
                v.setUint32(0, 0x08074b50, true);
                v.setUint32(4, (entry.crc ^ 0xffffffff) >>> 0, true);
                put64(v, 8, entry.size);
                put64(v, 16, entry.size);
                await owner.emit(descriptor);
                owner.active = null;
            },
            abort: () => owner.abort()
        };
        this.active = result;
        return result;
    }

    async mkdir(_path: string): Promise<void> {}

    async abort(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        await this.writer.abort();
    }

    async close(): Promise<void> {
        if (this.stopped) throw new Error('ZIP writer is closed');
        try {
            if (this.active) await this.active.close();
            const start = this.offset;
            for (const entry of this.entries) {
                const largeSize = entry.size >= ZIP32_MAX;
                const largeOffset = entry.offset >= ZIP32_MAX;
                const extra = (largeSize ? 16 : 0) + (largeOffset ? 8 : 0);
                const bytes = new Uint8Array(46 + entry.name.length + (extra ? extra + 4 : 0));
                const v = new DataView(bytes.buffer);
                v.setUint32(0, 0x02014b50, true);
                v.setUint16(4, 45, true);
                v.setUint16(6, 45, true);
                v.setUint16(8, 0x808, true);
                v.setUint16(14, 33, true);
                v.setUint32(16, (entry.crc ^ 0xffffffff) >>> 0, true);
                v.setUint32(20, largeSize ? ZIP32_MAX : entry.size, true);
                v.setUint32(24, largeSize ? ZIP32_MAX : entry.size, true);
                v.setUint16(28, entry.name.length, true);
                v.setUint16(30, extra ? extra + 4 : 0, true);
                v.setUint32(42, largeOffset ? ZIP32_MAX : entry.offset, true);
                bytes.set(entry.name, 46);
                let at = 46 + entry.name.length;
                if (extra) {
                    v.setUint16(at, 1, true);
                    v.setUint16(at + 2, extra, true);
                    at += 4;
                    if (largeSize) {
                        put64(v, at, entry.size); put64(v, at + 8, entry.size); at += 16;
                    }
                    if (largeOffset) put64(v, at, entry.offset);
                }
                await this.emit(bytes);
            }
            const size = this.offset - start;
            const count = this.entries.length;
            if (start >= ZIP32_MAX || size >= ZIP32_MAX || count >= 65535) {
                const recordOffset = this.offset;
                const bytes = new Uint8Array(76);
                const v = new DataView(bytes.buffer);
                v.setUint32(0, 0x06064b50, true);
                put64(v, 4, 44);
                v.setUint16(12, 45, true);
                v.setUint16(14, 45, true);
                put64(v, 24, count); put64(v, 32, count);
                put64(v, 40, size); put64(v, 48, start);
                v.setUint32(56, 0x07064b50, true);
                put64(v, 64, recordOffset);
                v.setUint32(72, 1, true);
                await this.emit(bytes);
            }
            const end = new Uint8Array(22);
            const v = new DataView(end.buffer);
            v.setUint32(0, 0x06054b50, true);
            v.setUint16(8, Math.min(count, 65535), true);
            v.setUint16(10, Math.min(count, 65535), true);
            v.setUint32(12, Math.min(size, ZIP32_MAX), true);
            v.setUint32(16, Math.min(start, ZIP32_MAX), true);
            await this.emit(end);
            await this.writer.close();
            this.stopped = true;
        } catch (error) {
            await this.abort().catch(() => {});
            throw error;
        }
    }
}
export { ZipFileSystem };
