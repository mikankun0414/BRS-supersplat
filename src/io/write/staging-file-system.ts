import type { FileSystem, Writer } from '@playcanvas/splat-transform';

// A private directory per operation: cleanup never removes user files or another
// export's staging. Without OPFS, retain Blob parts with a bounded memory budget.
const MEMORY_LIMIT = 128 * 1024 * 1024;
class StagingFileSystem implements FileSystem {
    private files = new Map<string, Blob | FileSystemFileHandle>();
    private active = new Set<Writer>();
    private memoryBytes = 0;
    private disposed = false;

    private constructor(private root?: FileSystemDirectoryHandle, private directory?: FileSystemDirectoryHandle, private name?: string) {}

    static async create(): Promise<StagingFileSystem> {
        if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
            // Quota/access failures must reach the caller; silently falling back
            // after disk failure would make a large export consume RAM instead.
            const root = await navigator.storage.getDirectory();
            const name = `supersplat-export-${crypto.randomUUID()}`;
            const directory = await root.getDirectoryHandle(name, { create: true });
            return new StagingFileSystem(root, directory, name);
        }
        return new StagingFileSystem();
    }

    async createWriter(filename: string): Promise<Writer> {
        if (this.disposed || this.files.has(filename)) throw new Error('Staging file already exists or is closed');
        const handle = await this.directory?.getFileHandle(crypto.randomUUID(), { create: true });
        const stream = await handle?.createWritable();
        if (handle) this.files.set(filename, handle);
        let count = 0;
        let closed = false;
        const parts: BlobPart[] = [];
        // Object methods expose Writer's byte counter; capture the owning FS.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const owner = this;
        const writer: Writer = {
            get bytesWritten() {
                return count;
            },
            async write(data) {
                if (closed || owner.disposed) throw new Error('Staging writer is closed');
                if (stream) await stream.write(data as unknown as ArrayBuffer);
                else {
                    if (owner.memoryBytes + data.length > MEMORY_LIMIT) throw new Error('Large download requires browser disk storage (OPFS) or a native file destination. Memory fallback is limited to 128 MiB.');
                    // Blob snapshots the bytes before a producer reuses its buffer.
                    parts.push(new Blob([data as BlobPart]));
                    owner.memoryBytes += data.length;
                }
                count += data.length;
            },
            async close() {
                if (closed) return;
                if (stream) await stream.close();
                else owner.files.set(filename, new Blob(parts));
                closed = true;
                parts.length = 0;
                owner.active.delete(writer);
            },
            async abort() {
                if (closed) return;
                closed = true;
                parts.length = 0;
                owner.active.delete(writer);
                if (stream) await stream.abort().catch(() => {});
            }
        };
        this.active.add(writer);
        return writer;
    }

    async mkdir(_path: string): Promise<void> {}

    async blob(filename: string): Promise<Blob> {
        const entry = this.files.get(filename);
        if (!entry) throw new Error(`Missing staged file ${filename}`);
        return entry instanceof Blob ? entry : await entry.getFile();
    }

    async copyTo(fs: FileSystem): Promise<void> {
        for (const filename of this.files.keys()) {
            const blob = await this.blob(filename);
            const writer = await fs.createWriter(filename);
            try {
                for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
                    await writer.write(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
                }
                await writer.close();
            } catch (error) {
                await writer.abort(); throw error;
            }
        }
    }

    async dispose(): Promise<void> {
        if (!this.disposed) {
            this.disposed = true;
            await Promise.all(Array.from(this.active, writer => writer.abort()));
            this.files.clear();
            this.memoryBytes = 0;
        }
        if (this.root && this.name) {
            await this.root.removeEntry(this.name, { recursive: true });
            this.name = undefined;
        }
    }
}
export { StagingFileSystem };
