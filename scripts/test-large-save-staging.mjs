import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loader, sink } from './test-large-save-helpers.mjs';

let removed = [], streams = [], handles = [], opened = [], urlRevoked = [], timers = [], downloads = [];
let release;
let block = false;
const elements = [];
function element() {
    const result = {
        children: [], style: {},
        append(...children) { this.children.push(...children); for (const child of children) child.parent = this; },
        appendChild(child) { this.append(child); },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
        get childElementCount() { return this.children.length; },
        fireEvent() {}
    };
    elements.push(result);
    return result;
}
const body = element();
const directory = {
    async getFileHandle(name) {
        const output = sink();
        const write = output.write;
        output.write = async bytes => { if (block) await new Promise(resolve => { release = resolve; }); await write((bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))); };
        streams.push(output);
        const handle = { async createWritable() { return output; }, async getFile() { return new Blob([output.data()]); } };
        handles.push(handle);
        return handle;
    }
};
const root = {
    async getDirectoryHandle(name) { opened.push(name); return directory; },
    async removeEntry(name) { removed.push(name); }
};
const load = loader({}, {
    navigator: { storage: { getDirectory: async () => root } },
    setTimeout: fn => { timers.push(fn); },
    window: { URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:staged'; }, revokeObjectURL: url => urlRevoked.push(url) } },
    document: { createElement: element, getElementById: id => body.children.find(child => child.id === id), body }
});
const { StagingFileSystem } = load('src/io/write/staging-file-system.ts');
const { BrowserFileSystem } = load('src/io/write/browser-file-system.ts');
const staging = await StagingFileSystem.create();
const writer = await staging.createWriter('folder/entry');
block = true;
let finished = false;
const bytes = new Uint8Array([1, 2, 3]);
const pending = writer.write(bytes).then(() => { finished = true; });
while (!release) await Promise.resolve();
assert.equal(finished, false);
release(); await pending; block = false;
await writer.close();
assert.deepEqual(new Uint8Array(await (await staging.blob('folder/entry')).arrayBuffer()), bytes);
const destination = sink();
await staging.copyTo({ createWriter: () => destination });
assert.deepEqual(destination.data(), Buffer.from(bytes));
await staging.dispose();
assert.equal(removed.length, 1);
assert.ok(removed[0].startsWith('supersplat-export-'));

const download = new BrowserFileSystem('large.bin').createWriter('ignored');
await download.write(bytes);
await download.close();
assert.equal(downloads.length, 1);
assert.equal(removed.length, 1, 'staged snapshot retained until explicit download completion');
assert.equal(timers.length, 0, 'no elapsed time can delete an active download');
assert.deepEqual(urlRevoked, []);
await elements.find(item => item.type === 'button').onclick();
assert.equal(removed.length, 2);
assert.deepEqual(urlRevoked, ['blob:staged']);

const cancelled = new BrowserFileSystem('cancelled.bin').createWriter('cancelled');
await cancelled.write(bytes);
await cancelled.abort();
await assert.rejects(() => cancelled.close(), /closed/);
assert.equal(downloads.length, 1);
assert.equal(removed.length, 3);

// Failure on disk close aborts and removes the private directory, no download.
const failure = new BrowserFileSystem('fail.bin').createWriter('fail');
await failure.write(bytes);
streams.at(-1).close = async () => { throw new Error('quota'); };
await assert.rejects(() => failure.close(), /quota/);
assert.equal(downloads.length, 1);
assert.equal(removed.length, 4);
assert.ok(streams.at(-1).aborted);

// Native writer reports acknowledged bytes and never consolidates output.
const native = { seek: async () => {}, write: async () => { throw new Error('disk'); }, truncate: async () => {}, close: async () => {}, abort: async () => {} };
const direct = new BrowserFileSystem('native', native).createWriter('native');
await assert.rejects(() => direct.write(bytes), /disk/);
assert.equal(direct.bytesWritten, 0);
await direct.abort();

// No OPFS: Blob-part fallback snapshots reused buffers and has a finite budget.
const legacy = loader({}, { navigator: {} })('src/io/write/staging-file-system.ts').StagingFileSystem;
const memory = await legacy.create();
const memoryWriter = await memory.createWriter('memory');
const reused = new Uint8Array([7, 8]);
await memoryWriter.write(reused); reused.fill(0);
await memoryWriter.close();
assert.deepEqual(new Uint8Array(await (await memory.blob('memory')).arrayBuffer()), new Uint8Array([7, 8]));
const limited = await memory.createWriter('limit');
const block8 = new Uint8Array(8 * 1024 * 1024);
await assert.rejects(async () => { for (let i = 0; i < 17; i++) await limited.write(block8); }, /128 MiB/);
await memory.dispose();
// Regression for Windows shell encoding loss: key parity alone accepts "???".
for (const name of readdirSync('static/locales').filter(name => name.endsWith('.json'))) {
    const locale = JSON.parse(readFileSync(`static/locales/${name}`, 'utf8'));
    for (const key of ['download.keep-temporary', 'download.cleanup']) {
        assert.ok(locale[key]?.length > 0, `${name}: ${key} missing`);
        assert.doesNotMatch(locale[key], /[?\ufffd]/, `${name}: ${key} encoding corruption`);
    }
}
console.log('PASS staging: OPFS streaming/backpressure, snapshot lifetime, cleanup on close failure/abort, native bytes, bounded legacy Blob fallback');
