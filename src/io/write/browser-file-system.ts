/**
 * Browser FileSystem implementation for splat-transform compatibility.
 * Provides FileSystem abstraction for browser file operations.
 */

import type { FileSystem, Writer } from '@playcanvas/splat-transform';

import { StagingFileSystem } from './staging-file-system';
import { i18n } from '../../ui/localization';

/**
 * Writer implementation for FileSystemWritableFileStream (File System Access API).
 */
class BrowserFileWriter implements Writer {
    private stream: FileSystemWritableFileStream;
    private cursor: number = 0;
    private ready: Promise<void>;

    constructor(stream: FileSystemWritableFileStream) {
        this.stream = stream;
        this.ready = this.stream.seek(0);
    }

    get bytesWritten(): number {
        return this.cursor;
    }

    async write(data: Uint8Array): Promise<void> {
        await this.ready;
        await this.stream.write(data as unknown as ArrayBuffer);
        this.cursor += data.byteLength;
    }

    async close(): Promise<void> {
        await this.ready;
        await this.stream.truncate(this.cursor);
        await this.stream.close();
    }

    async abort(): Promise<void> {
        try {
            await this.ready.catch(() => {});
            await this.stream.abort();
        } catch {
            // already failing — ignore
        }
    }
}

/**
 * Trigger a browser download for the given data.
 */
const triggerDownload = (blob: Blob, filename: string, cleanup: () => Promise<void>): void => {
    const url = window.URL.createObjectURL(blob);

    // A File snapshot still depends on its OPFS backing file. There is no web
    // API for download completion: timers or page unload cannot safely delete
    // it (a large/slow download may still be reading). Explicit user cleanup
    // keeps both the URL and backing file alive until download completion.
    let controls = document.getElementById('download-cleanup');
    if (!controls) {
        controls = document.createElement('div');
        controls.id = 'download-cleanup';
        Object.assign(controls.style, { position: 'fixed', bottom: '64px', right: '16px', zIndex: '10000', maxWidth: '360px', maxHeight: '50vh', overflow: 'auto', color: '#eee', background: '#333', padding: '12px', borderRadius: '4px' });
        document.body.appendChild(controls);
    }
    const notice = document.createElement('div');
    const message = document.createElement('p');
    const button = document.createElement('button');
    button.type = 'button';
    const unbind = i18n.onChange(() => {
        message.textContent = i18n.t('download.keep-temporary', { filename });
        button.textContent = i18n.t('download.cleanup');
    });
    button.onclick = async () => {
        button.disabled = true;
        try {
            await cleanup();
            window.URL.revokeObjectURL(url);
            unbind();
            notice.remove();
            if (!controls.childElementCount) controls.remove();
        } catch (error) {
            console.warn(error);
            button.disabled = false;
        }
    };
    notice.append(message, button);
    controls.appendChild(notice);

    const lnk = document.createElement('a');
    lnk.download = filename;
    lnk.href = url;

    // create a "fake" click-event to trigger the download
    if (document.createEvent) {
        const e = document.createEvent('MouseEvents');
        e.initMouseEvent('click', true, true, window,
            0, 0, 0, 0, 0, false, false, false,
            false, 0, null);
        lnk.dispatchEvent(e);
    } else {
        // @ts-ignore
        lnk.fireEvent?.('onclick');
    }

};

/** Download via an OPFS File snapshot, or bounded Blob parts on older browsers. */
class BrowserDownloadWriter implements Writer {
    private staging: Promise<StagingFileSystem>;
    private inner: Promise<Writer>;
    private count = 0;
    private stopped = false;

    constructor(private filename: string) {
        this.staging = StagingFileSystem.create();
        this.inner = this.staging.then(fs => fs.createWriter(filename));
    }

    get bytesWritten(): number {
        return this.count;
    }

    async write(data: Uint8Array): Promise<void> {
        if (this.stopped) throw new Error('Download writer is closed');
        try {
            await (await this.inner).write(data);
            this.count += data.length;
        } catch (error) {
            await this.abort(); throw error;
        }
    }

    async close(): Promise<void> {
        if (this.stopped) throw new Error('Download writer is closed');
        try {
            await (await this.inner).close();
            const staging = await this.staging;
            const blob = await staging.blob(this.filename);
            triggerDownload(blob, this.filename, () => staging.dispose());
            this.stopped = true;
        } catch (error) {
            await this.abort(); throw error;
        }
    }

    async abort(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        await this.inner.then(writer => writer.abort()).catch(() => {});
        await this.staging.then(fs => fs.dispose()).catch(() => {});
    }
}

/**
 * FileSystem implementation for browser environments.
 * Supports both File System Access API (stream) and fallback download.
 */
class BrowserFileSystem implements FileSystem {
    private stream?: FileSystemWritableFileStream;
    private filename: string;

    /**
     * Create a BrowserFileSystem.
     * @param filename - The filename for downloads (fallback mode)
     * @param stream - Optional FileSystemWritableFileStream for direct file access
     */
    constructor(filename: string, stream?: FileSystemWritableFileStream) {
        this.filename = filename;
        this.stream = stream;
    }

    createWriter(_filename: string): Writer {
        if (this.stream) {
            return new BrowserFileWriter(this.stream);
        }
        return new BrowserDownloadWriter(this.filename);
    }

    mkdir(_path: string): Promise<void> {
        // No-op in browser - directories not supported
        return Promise.resolve();
    }
}

export { BrowserFileSystem };
