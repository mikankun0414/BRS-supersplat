import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pc from 'playcanvas';

const device = new pc.NullGraphicsDevice({ width: 64, height: 64 });
const mesh = new pc.Mesh(device);
mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0]);
mesh.setNormals([0, 0, 1, 0, 0, 1, 0, 0, 1]);
mesh.setUvs(0, [0, 0, 1, 0, 0, 1]);
mesh.setIndices([0, 1, 2]);
mesh.update();
// Same in-place update used by mesh editing.
mesh.setPositions([0, 0, 2, 1, 0, 0, 0, 1, 0]);
mesh.update();
const root = new pc.Entity('edited-model');
root.setLocalPosition(3, 4, 5);
root.setLocalScale(2, 2, 2);
const child = new pc.Entity('road');
root.addChild(child);
const material = new pc.StandardMaterial();
material.name = 'road-material';
child.render = { enabled: true, meshInstances: [new pc.MeshInstance(mesh, material, child)] };
class GltfModel {}
const model = Object.assign(new GltfModel(), { entity: root, filename: 'road.glb' });
let selection = model;
let saved;
let writerClosed = false;
let pickerOptions;
let popup;
let failWrite = false;
let aborted = false;
const emitted = [];
const handlers = new Map();
const events = {
    function: (name, fn) => handlers.set(name, fn),
    on: () => {},
    fire: name => emitted.push(name),
    invoke: (name, ...args) => name === 'selection' ? selection : name === 'showPopup' ? (popup = args[0]) : handlers.get(name)?.(...args)
};
const stream = { abort: async () => { aborted = true; } };
const window = {
    showOpenFilePicker: () => {},
    showSaveFilePicker: async options => { pickerOptions = options; return { createWritable: async () => stream }; }
};
class BrowserFileSystem {
    createWriter() {
        return {
            write: async data => { if (failWrite) throw new Error('disk full'); saved = data; },
            close: async () => { writerClosed = true; }
        };
    }
}
const compiled = ts.transpileModule(readFileSync('src/file-handler.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports, window, setTimeout, console, Uint8Array,
    require: name => ({
        playcanvas: pc,
        './model': { GltfModel },
        './io': { BrowserFileSystem },
        './drop-handler': { CreateDropHandler: () => {} },
        './export-settings': { loadExportSettings: async () => ({}) },
        './recent-files': { recentImports: [] },
        './ui/localization': { i18n: { t: key => key } }
    })[name] ?? {}
});
exports.initFileHandler({}, events, {});
assert.equal(events.invoke('model.canExport'), true);
await events.invoke('model.export');
assert.equal(popup, undefined);
assert.equal(pickerOptions.suggestedName, 'road_edited.glb');
assert.ok(writerClosed);
const view = new DataView(saved.buffer, saved.byteOffset, saved.byteLength);
assert.equal(view.getUint32(0, true), 0x46546c67);
assert.equal(view.getUint32(4, true), 2);
assert.equal(view.getUint32(8, true), saved.byteLength);
const jsonLength = view.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(saved.subarray(20, 20 + jsonLength)));
const primitive = json.meshes[0].primitives[0];
const accessor = json.accessors[primitive.attributes.POSITION];
const bufferView = json.bufferViews[accessor.bufferView];
const offset = 28 + jsonLength + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
assert.equal(view.getFloat32(offset + 8, true), 2, 'edited vertex saved');
assert.ok(primitive.attributes.TEXCOORD_0 !== undefined, 'UV retained');
assert.ok(primitive.attributes.NORMAL !== undefined, 'normals retained');
assert.equal(json.materials[0].name, 'road-material');
assert.deepEqual(json.nodes[0].translation, [3, 4, 5]);
assert.deepEqual(json.nodes[0].scale, [2, 2, 2]);
assert.deepEqual(emitted, ['startSpinner', 'stopSpinner']);
window.showSaveFilePicker = async () => { throw { name: 'AbortError' }; };
await events.invoke('model.export');
assert.equal(popup, undefined);
assert.equal(events.invoke('model.canExport'), true);
delete window.showSaveFilePicker;
writerClosed = false;
await events.invoke('model.export');
assert.ok(writerClosed, 'download fallback');
window.showSaveFilePicker = async () => ({ createWritable: async () => stream });
failWrite = true;
await events.invoke('model.export');
assert.ok(aborted);
assert.equal(popup.type, 'error');
assert.equal(events.invoke('model.canExport'), true);
selection = null;
assert.equal(events.invoke('model.canExport'), false);
console.log('PASS: GLB binary contains edited vertices, UVs, normals, material and transforms; export, cancellation, fallback and write failure');
