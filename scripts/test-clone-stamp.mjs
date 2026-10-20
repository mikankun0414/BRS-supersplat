import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pc from 'playcanvas';

// Run the real tool, Splat.createLayer, selectedRanges and AddSplatOp with
// CPU stand-ins for GPU storage / bounds and DOM. No browser or GPU acceptance.
const load = (path, dependencies = {}) => {
    const source = readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, console, require: name => {
        if (name === 'playcanvas') return pc;
        return dependencies[name] ?? {};
    } });
    return exports;
};
const { IndexRanges } = load('index-ranges');
const { Element, ElementType } = load('element');
const { Events } = load('events');
const { CommandQueue } = load('command-queue');
class Instances {
    constructor(device, count) {
        this.count = count;
        this.sourceRow = Uint32Array.from({ length: count }, (_, i) => i);
        this.flags = new Uint8Array(count).fill(1);
        this.palette = new Uint32Array(count);
    }
    static fromSubset(device, source, ranges) {
        const copy = new Instances(device, ranges.count);
        let dst = 0;
        ranges.forEach(i => {
            copy.sourceRow[dst] = source.sourceRow[i];
            copy.flags[dst] = source.flags[i];
            copy.palette[dst++] = source.palette[i];
        });
        return copy;
    }
    transformIndex(i) { return this.palette[i] & 0xffff; }
    setTransformIndex(i, index) { this.palette[i] = index; }
    colorIndex() { return 0; }
    flush() { assert.ok(!this.destroyed); this.flushed = true; }
    destroy() { assert.ok(!this.destroyed, 'double destroy'); this.destroyed = true; }
}
class Palette {
    entries = [new pc.Mat4()];
    alloc() { this.entries.push(new pc.Mat4()); return this.entries.length - 1; }
    getTransform(i, mat) { mat.copy(this.entries[i]); }
    setTransform(i, mat) { this.entries[i] = mat.clone(); }
    destroy() {}
}
const grades = { createGradeTerms: () => ({}) };
const { Splat } = load('splat', {
    './element': { Element, ElementType }, './gaussian-instances': { GaussianInstances: Instances },
    './transform-palette': { TransformPalette: Palette }, './color-palette': { ColorPalette: Palette },
    './color-grade': grades
});
const editOps = load('edit-ops', {
    './index-ranges': { IndexRanges }, './splat-state': { State: { selected: 1 } }, './color-grade': grades
});
class Dom {
    listeners = new Map();
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 900 }; }
    emit(name, properties) {
        this.listeners.get(name)?.({ pointerType: 'mouse', button: 0, altKey: false,
            preventDefault() {}, stopPropagation() {}, ...properties });
    }
}
class Container {
    dom = new Dom();
    append() {}
}
class Label {
    static created = [];
    constructor() { Label.created.push(this); }
}
class ToolOverlay {}
const { CloneStampTool, stampPosition } = load('tools/clone-stamp-tool', {
    '@playcanvas/pcui': { Container, Label }, '../edit-ops': editOps,
    '../element': { ElementType }, '../index-ranges': { IndexRanges },
    '../tool-overlay': { ToolOverlay }, '../ui/localization': { i18n: { t: key => key, bindText() {} } }
});
const close = (actual, expected) => {
    for (const axis of ['x', 'y', 'z']) {
        assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-4,
            `${axis}: ${actual[axis]} != ${expected[axis]}`);
    }
};
const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const transformedPoints = splat => Array.from({ length: splat.instances.count }, (_, i) => {
    const point = splat.resource.points[splat.instances.sourceRow[i]].clone();
    const transform = new pc.Mat4();
    splat.transformPalette.getTransform(splat.instances.transformIndex(i), transform);
    return transform.transformPoint(point);
});
const boundsCenter = splat => {
    const points = transformedPoints(splat);
    const min = points[0].clone();
    const max = min.clone();
    points.forEach(p => { min.min(p); max.max(p); });
    return min.add(max).mulScalar(0.5);
};
const fixture = () => {
    const events = new Events();
    const contentRoot = new pc.Entity();
    contentRoot.setLocalPosition(10, -7, 4);
    contentRoot.setLocalEulerAngles(17, 63, -21);
    contentRoot.setLocalScale(2, 0.7, 1.4);
    const points = [new pc.Vec3(-3, 1, 2), new pc.Vec3(5, 4, -2), new pc.Vec3(400, 90, 10)];
    const resource = { device: {}, numRows: points.length, aabb: new pc.BoundingBox(), points,
        acquire() {}, release: () => false };
    const source = new Splat({ resource, file: { filename: 'fixture.ply' } }, new pc.Quat().setFromEulerAngles(29, -38, 11));
    source.entity.setLocalPosition(3, -2, 5);
    source.entity.setLocalScale(0.5, 3, 1.2);
    contentRoot.addChild(source.entity);
    source.instances.flags[2] = 0;
    source.transformPalette.alloc(); // Force non-identity, nontrivial palette remapping.
    const idx = source.transformPalette.alloc();
    source.transformPalette.setTransform(idx, new pc.Mat4().setTRS(
        new pc.Vec3(12, -5, 3), new pc.Quat().setFromEulerAngles(0, 30, 45), new pc.Vec3(1, 2, 0.8)));
    source.instances.setTransformIndex(1, idx);
    // Deliberately stale / wrong cache. Production capture must never read it.
    Object.defineProperty(source, 'selectionBound', { get() { throw new Error('stale selection bounds read'); } });
    const ops = [];
    const picks = [];
    const captures = [];
    const poses = [];
    let selection = source;
    const scene = {
        contentRoot, commandQueue: new CommandQueue(),
        canvas: { getBoundingClientRect: () => ({ left: 100, top: 80, width: 800, height: 600 }) },
        camera: {
            mainCamera: new pc.Entity(), camera: { orthoHeight: 4 }, near: 0.1, far: 100,
            intersect: async (x, y) => { picks.push([x, y]); return scene.pickResult; },
            intersectMany: async (points, splats, pose) => {
                poses.push(pose);
                return Promise.all(points.map(({ x, y }) => scene.camera.intersect(x, y)));
            }
        },
        pickResult: { position: new pc.Vec3(-20, 8, 17) },
        dataProcessor: { calcBound: async (captured, selected, local) => {
            assert.equal(captured.entity.parent, null, 'template must remain unparented');
            assert.ok(captured.instances.flushed, 'upload subset / remapped palette indices');
            captures.push(captured);
            await scene.boundGate?.promise;
            assert.ok(!captured.instances.destroyed, 'readback buffers must stay alive');
            local.center.copy(boundsCenter(captured));
            selected.center.copy(local.center);
        } },
        add(element) {
            element.scene = scene;
            if (element.entity) contentRoot.addChild(element.entity);
        },
        remove(element) { element.entity?.parent?.removeChild(element.entity); element.scene = null; }
    };
    source.scene = scene;
    events.function('selection', () => selection);
    events.on('selection', splat => { selection = splat; });
    events.on('edit.add', op => { ops.push(op); op.do(); });
    const container = new Container();
    const tool = new CloneStampTool(events, scene, container);
    const click = (altKey = false, clientX = 300, clientY = 380) => {
        container.dom.emit('pointerdown', { altKey, clientX, clientY });
        container.dom.emit('pointerup', { altKey, clientX, clientY });
    };
    return { source, scene, events, tool, click, ops, picks, captures, poses,
        hint: Label.created.at(-1), selection: () => selection };
};

// Pure offset sanity and a general nonuniform rotated parent.
close(stampPosition(new pc.Vec3(1, 2, 3), pc.Vec3.ZERO, new pc.Vec3(5, 0, -2), new pc.Mat4()), new pc.Vec3(6, 2, 1));
const parent = new pc.Mat4().setTRS(new pc.Vec3(10, -3, 2), new pc.Quat().setFromEulerAngles(12, 90, 30), new pc.Vec3(2, 0.5, 3));
const local = new pc.Vec3(0.5, 1, -1);
const anchor = new pc.Vec3(1, 0, 1);
const target = new pc.Vec3(4, 1, -3);
close(parent.transformPoint(stampPosition(local, anchor, target, parent)).sub(parent.transformPoint(local)), target.clone().sub(anchor));

// Actual activation -> capture -> immediate click waits for fresh bounds.
const f = fixture();
f.scene.boundGate = deferred();
f.tool.activate();
f.click();
await tick();
assert.equal(f.ops.length, 0);
f.scene.boundGate.resolve();
await tick();
assert.equal(f.ops.length, 1);
assert.ok(f.ops[0] instanceof editOps.AddSplatOp);
assert.deepEqual(f.picks[0], [0.25, 0.5], 'normalize against canvas, not enclosing container');
const checkCopy = op => {
    close(op.splat.worldTransform.transformPoint(boundsCenter(op.splat)), f.scene.pickResult.position);
    close(op.splat.entity.getLocalScale(), f.captures.at(-1).entity.getLocalScale());
    assert.ok(op.splat.entity.getLocalRotation().equalsApprox(f.captures.at(-1).entity.getLocalRotation()));
    assert.equal(op.splat.instances.count, 2, 'unselected instance excluded');
    assert.equal(f.selection(), f.source);
};
checkCopy(f.ops[0]);
const initialPoints = transformedPoints(f.ops[0].splat);
f.source.entity.setLocalPosition(100, 100, 100);
f.source.transformPalette.setTransform(2, new pc.Mat4().setTranslate(80, 90, 100));
f.source.instances.flags.fill(0);
f.scene.contentRoot.setLocalEulerAngles(-25, 10, 52);
f.scene.pickResult = { position: new pc.Vec3(35, -8, 6) };
f.click();
await tick();
checkCopy(f.ops[1]);
transformedPoints(f.ops[1].splat).forEach((p, i) => close(p, initialPoints[i]));
f.ops[1].undo();
assert.equal(f.ops[1].splat.entity.parent, null);
await f.ops[1].do();
checkCopy(f.ops[1]);

// Alt+click far from the selected center refreshes source without depth picking.
f.source.instances.flags[0] = 1;
f.source.instances.flags[1] = 1;
f.click(true, 890, 85);
await tick();
assert.equal(f.picks.length, 2, 'Alt refresh must not pick a pivot');
f.click();
await tick();
checkCopy(f.ops[2]);
assert.notEqual(f.ops[2].splat.entity.getLocalPosition().x, f.ops[1].splat.entity.getLocalPosition().x);
// An empty Alt refresh discards the previous template rather than stamping it.
f.source.instances.flags.fill(0);
f.click(true);
f.click();
await tick();
assert.equal(f.ops.length, 3);

const miss = fixture();
miss.tool.activate();
await tick();
miss.scene.pickResult = null;
miss.click();
await tick();
assert.equal(miss.ops.length, 0, 'a surface miss adds no layer');

// Source refresh, deactivation and scene clear invalidate in-flight surface hits.
for (const cancel of ['refresh', 'deactivate', 'clear']) {
    const h = fixture();
    h.tool.activate();
    await tick();
    const hit = deferred();
    h.scene.camera.intersect = () => hit.promise;
    h.click();
    if (cancel === 'refresh') h.click(true, 890, 85);
    if (cancel === 'deactivate') h.tool.deactivate();
    if (cancel === 'clear') h.events.fire('scene.clear');
    hit.resolve(h.scene.pickResult);
    await tick();
    assert.equal(h.ops.length, 0, `stale hit after ${cancel}`);
}
// Overlapping captures retain buffers until readback ends; only the latest wins.
const h = fixture();
h.scene.boundGate = deferred();
h.tool.activate();
await tick();
const stale = h.captures[0];
h.click(true);
assert.ok(!stale.instances.destroyed);
h.click();
h.scene.boundGate.resolve();
await tick();
assert.ok(stale.instances.destroyed);
assert.equal(h.ops.length, 1);
assert.equal(h.captures.length, 2);

const empty = fixture();
empty.source.instances.flags.fill(0);
empty.tool.activate();
empty.click(true);
empty.click();
await tick();
assert.equal(empty.ops.length, 0);
assert.equal(empty.captures.length, 0);
// A cleared source cannot return after its bounds finish.
const cleared = fixture();
cleared.scene.boundGate = deferred();
cleared.tool.activate();
await tick();
cleared.events.fire('scene.clear');
cleared.scene.boundGate.resolve();
await tick();
assert.ok(cleared.captures[0].instances.destroyed);
assert.equal(cleared.ops.length, 0);

// A delayed capture must pick using the click-time camera, including ortho / clip state.
const moving = fixture();
moving.scene.boundGate = deferred();
moving.scene.camera.mainCamera.setPosition(1, 2, 3);
moving.scene.camera.mainCamera.setEulerAngles(12, 24, 36);
const clickPosition = moving.scene.camera.mainCamera.getPosition().clone();
const clickRotation = moving.scene.camera.mainCamera.getRotation().clone();
moving.tool.activate();
moving.click();
await tick();
moving.scene.camera.mainCamera.setPosition(80, 90, 100);
moving.scene.camera.mainCamera.setEulerAngles(50, 60, 70);
moving.scene.camera.camera.orthoHeight = 40;
moving.scene.camera.near = 5;
moving.scene.camera.far = 900;
moving.scene.boundGate.resolve();
await tick();
assert.equal(moving.poses.length, 1, 'delayed pick requires an explicit camera snapshot');
close(moving.poses[0].position, clickPosition);
assert.ok(moving.poses[0].rotation.equalsApprox(clickRotation));
assert.equal(moving.poses[0].orthoHeight, 4);
assert.equal(moving.poses[0].near, 0.1);
assert.equal(moving.poses[0].far, 100);
assert.equal(moving.ops.length, 1);

// Reactivation owns a new capture; the cancelled readback must not swallow its click.
const reactivated = fixture();
reactivated.scene.boundGate = deferred();
reactivated.tool.activate();
await tick();
const cancelledCapture = reactivated.captures[0];
reactivated.tool.deactivate();
reactivated.tool.activate();
reactivated.click();
assert.ok(!cancelledCapture.instances.destroyed, 'old readback still owns its buffers');
reactivated.scene.boundGate.resolve();
await tick();
assert.equal(reactivated.ops.length, 1, 'first click after reactivation must stamp');
assert.equal(reactivated.captures.length, 2);
assert.ok(cancelledCapture.instances.destroyed);

const noSelectionHint = fixture();
noSelectionHint.source.instances.flags.fill(0);
noSelectionHint.tool.activate();
assert.equal(noSelectionHint.hint.text, 'clone-stamp.no-selection');
console.log('clone stamp: ok (real capture/stamp/createLayer/AddSplatOp paths; CPU GPU/DOM stubs)');

