import assert from 'node:assert/strict';
import * as pc from 'playcanvas';
import * as transform from '@playcanvas/splat-transform';
import { loader, sink } from './test-large-save-helpers.mjs';
import { fixture } from './test-large-save-instances.mjs';

// Synthetic document integration: actual doc events, instance codec, ZIP
// writer/reader and BrowserFileWriter. GPU assets use a deterministic row
// payload stand-in; this does not claim browser/real-PLY visual acceptance.
let splats = [], currentFile = new Blob(), failClose = false, failWrite = false, failCreate = false;
let resourceWrites = [], rebinds = 0, saved = 0, popups = [], discarded = 0;
let nextSettings;
let rebindPoliciesChecked = 0;
const names = [], recent = [];
const handlers = new Map(), listeners = new Map();
const handle = {
    name: 'test.ssproj',
    async queryPermission() { return 'granted'; },
    async isSameEntry(other) { return other === handle; },
    async getFile() { return currentFile; },
    async createWritable() {
        if (failCreate) throw new Error('cannot create destination');
        const staged = sink();
        return {
            seek: async () => {}, truncate: async () => {},
            async write(data) { if (failWrite) throw new Error('write failed'); await staged.write((data instanceof Uint8Array ? data : new Uint8Array(data))); },
            async close() { if (failClose) throw new Error('close failed'); currentFile = new Blob([staged.data()]); },
            async abort() { await staged.abort(); }
        };
    }
};
const events = {
    function: (name, fn) => handlers.set(name, fn),
    on: (name, fn) => { const set = listeners.get(name) ?? []; set.push(fn); listeners.set(name, set); },
    fire(name, ...args) {
        if (name === 'scene.clear') splats = [];
        if (name === 'doc.saved') saved++;
        if (name === 'doc.setName') names.push(args[0]);
        for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    invoke(name, ...args) {
        if (name === 'scene.allSplats') return splats;
        if (name === 'scene.empty') return splats.length === 0;
        if (name === 'showPopup') { if (args[0].type === 'error') popups.push(args[0]); return { action: 'yes' }; }
        if (name === 'show.savePopup') return nextSettings;
        if (name.startsWith('docSerialize.')) return { captured: name };
        return handlers.get(name)?.(...args);
    }
};
const baseLoad = loader();
const io = baseLoad('src/io/read/file-systems.ts');
const { BrowserFileSystem } = baseLoad('src/io/write/browser-file-system.ts');
const { ZipReadFileSystem } = baseLoad('src/io/read/zip-file-system.ts');
const { decodeInstances } = baseLoad('src/doc-instances.ts');
// Exercise the real loader's >5M gate without allocating a >5M-row GPU scene.
const largeSource = { meta: { numGaussians: 5_000_001, numLods: 1, chunkSize: 256,
    availableLayers: new Set(['position', 'geometric', 'color']) }, async close() {} };
const largeLoader = loader({
    '@playcanvas/splat-transform': { ...transform, readFile: async () => [largeSource] },
    './uniform-subset-source': { createUniformSubsetSource(parent, count) {
        return { ...parent, meta: { ...parent.meta, numGaussians: count } };
    } }
})('src/io/read/loader.ts');
function palette(kind) {
    const entries = [];
    return {
        size: 1,
        alloc(n) { this.size += n; },
        setTransform(i, mat) { entries[i] = mat.clone(); },
        getTransform(i, mat) { mat.copy(entries[i]); },
        setEntry(i, terms) { entries[i] = structuredClone(terms); },
        getEntry(i, terms) { Object.assign(terms, entries[i]); },
        entries, kind
    };
}
class Splat {
    constructor(asset, rotation, instances) {
        this.asset = asset; this.rotation = rotation; this.instances = instances; this.resource = asset.resource;
        this.transformPalette = palette('transform'); this.colorPalette = palette('color');
    }
    docSerialize() { return this.settings; }
    docDeserialize(settings) { this.settings = settings; }
}
async function resourceFromArchive(filename, fs) {
    const data = await fs.createSource(filename);
    const rows = JSON.parse(new TextDecoder().decode(await data.read().readAll()));
    return { numRows: rows.length, source: data, rows,
        async rebind(source) { this.source = source; rebinds++; }
    };
}
const scene = {
    app: { graphicsDevice: {} },
    camera: { docSerialize: () => ({ fov: 58 }), docDeserialize: () => {}, reset: () => {} },
    bound: {},
    async add(splat) { splats.push(splat); },
    assetLoader: { async loadAsset(filename, fs) { return { asset: { resource: await resourceFromArchive(filename, fs) }, rotation: new pc.Quat() }; } }
};
const load = loader({
    './io': { BrowserFileSystem, BlobReadSource: io.BlobReadSource, sourcesOf: io.sourcesOf,
        loadSplatSource: async (filename, fs, skipReorder, pickLod, pickLargeLoad) => {
            const loaded = await largeLoader.loadSplatSource(filename, fs, skipReorder, pickLod, pickLargeLoad);
            assert.equal(loaded.source.meta.numGaussians, 5_000_001, 'rebind must retain all rows above preview threshold');
            rebindPoliciesChecked++;
            return { source: (await resourceFromArchive(filename, fs)).source };
        } },
    './recent-files': { recentFiles: { add(entry) { recent.push(entry); } } },
    './splat': { Splat },
    './gaussian-instances': { GaussianInstances: { fromRecords: (device, rows, sourceRow, flags, palette) => ({ count: sourceRow.length, sourceRow, flags, palette }) } },
    './transform': { Transform: class {} },
    './ui/localization': { i18n: { t: key => key } },
    './splat-serialize': { async writeResourceFile(resource, rows, filename, fs) {
        resourceWrites.push(Array.from(rows));
        const writer = await fs.createWriter(filename);
        await writer.write(new TextEncoder().encode(JSON.stringify(Array.from(rows, i => resource.rows[i]))));
        await writer.close();
    } }
}, { window: { showOpenFilePicker: async () => [handle], showDirectoryPicker: () => {} } });
load('src/doc.ts').registerDocEvents(scene, events);
const resource = { numRows: 8, rows: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] };
function layer(rows, id) {
    const object = Object.assign(new Splat({ resource }, new pc.Quat(), null), fixture(rows.length));
    object.instances.sourceRow.set(rows);
    object.settings = { id, transform: { position: [id, id + 1, id + 2], scale: [2, 3, 4] }, tint: [0.3, 0.5, 0.8] };
    return object;
}
splats = [layer([1, 3, 1], 0), layer([3, 6], 1)];
const expectedSettings = splats.map(splat => structuredClone(splat.settings));
const expectedPalettes = splats.map(splat => splat.instances.palette.slice());
nextSettings = { fileTarget: { handle, discard: () => { discarded++; } } };
await events.invoke('doc.saveAs');
assert.equal(saved, 1);
assert.equal(popups.length, 0);
assert.deepEqual(resourceWrites, [[1, 3, 6]], 'shared static data written once, union preserved');
assert.deepEqual(splats[0].instances.sourceRow, new Uint32Array([1, 3, 1]), 'live source rows untouched');
const fs = new ZipReadFileSystem(new io.BlobReadSource(currentFile));
const document = JSON.parse(new TextDecoder().decode(await (await fs.createSource('document.json')).read().readAll()));
assert.equal(document.resources.length, 1);
assert.equal(document.resources[0].numRows, 3);
assert.equal(document.splats[0].resource, document.splats[1].resource);
assert.deepEqual(decodeInstances(await (await fs.createSource('instances_0.bin')).read().readAll()).sourceRow, new Uint32Array([0, 1, 0]));

await events.invoke('doc.open');
assert.equal(popups.length, 0, JSON.stringify(popups));
assert.equal(splats.length, 2);
assert.equal(splats[0].resource, splats[1].resource, 'sharing restored');
assert.deepEqual(splats[0].instances.sourceRow, new Uint32Array([0, 1, 0]));
for (let i = 0; i < 2; i++) {
    assert.deepEqual(JSON.parse(JSON.stringify(splats[i].settings.transform)), expectedSettings[i].transform);
    assert.deepEqual(splats[i].instances.palette, expectedPalettes[i]);
    assert.equal(splats[i].colorPalette.size, 4);
    assert.equal(splats[i].transformPalette.size, 3);
}
// Simulate removing a referenced instance while undo still owns its row. An
// in-place save must retain every resource row, including no-longer-used row 2.
splats[1].instances.count = 1;
splats[1].instances.sourceRow[0] = 1;
resourceWrites = [];
await events.invoke('doc.save');
assert.equal(saved, 2);
assert.deepEqual(resourceWrites, [[0, 1, 2]], 'in-place keeps undo rows');
assert.equal(rebinds, 1, 'shared resource rebound once');
assert.equal(rebindPoliciesChecked, 1, 'actual loader gate exercised with document rebind policy');
assert.equal(splats[0].instances.sourceRow[1], 1);
assert.equal(new TextDecoder().decode(await splats[0].resource.source.read().readAll()), '["b","d","g"]', 'new archive backs lazy resource');
await events.invoke('doc.open');
assert.equal(splats[0].resource.numRows, 3);
assert.deepEqual(splats[0].instances.sourceRow, new Uint32Array([0, 1, 0]));

const previous = new Uint8Array(await currentFile.arrayBuffer());
for (const phase of ['write', 'close']) {
    failWrite = phase === 'write'; failClose = phase === 'close';
    await events.invoke('doc.save');
    assert.equal(saved, 2, 'failed overwrite not marked saved');
    assert.deepEqual(new Uint8Array(await currentFile.arrayBuffer()), previous, 'old file preserved');
}
failWrite = false; failClose = true;
await events.invoke('doc.saveAs');
assert.equal(discarded, 1);
assert.equal(saved, 2);
assert.ok(popups.length >= 3);
failClose = false;
failCreate = true;
const popupCount = popups.length;
await events.invoke('doc.save');
assert.equal(popups.length, popupCount + 1, 'unexpected save failure must be visible');
assert.equal(saved, 2);
assert.deepEqual(new Uint8Array(await currentFile.arrayBuffer()), previous);
failCreate = false;

// Failed drag/drop/import/PWA load must never adopt its handle for Ctrl+S.
let badWrites = 0;
const badFile = new Blob(['not a project']);
badFile.name = 'rejected.ssproj';
const badHandle = { ...handle, name: badFile.name, async getFile() { return badFile; },
    async createWritable() { badWrites++; return handle.createWritable(); } };
const namesBefore = names.length, recentBefore = recent.length;
assert.equal(await events.invoke('doc.load', badFile, badHandle), false);
assert.ok(!names.slice(namesBefore).includes(badFile.name));
assert.equal(recent.length, recentBefore);
nextSettings = null; // cancel Save As; rejected source is not a destination
await events.invoke('doc.save');
assert.equal(badWrites, 0, 'rejected source must not be overwritten');
assert.deepEqual(new Uint8Array(await badFile.arrayBuffer()), new TextEncoder().encode('not a project'));
const validFile = new Blob([previous]);
validFile.name = 'imported.ssproj';
assert.equal(await events.invoke('doc.load', validFile, handle), true, 'successful import still adopts destination');
assert.equal(recent.at(-1).handle, handle);
console.log('PASS project integration: shared resource save/open, transforms/grades/flags, compact mapping, in-place rebind/undo rows and transactional failures (synthetic asset loader)');
