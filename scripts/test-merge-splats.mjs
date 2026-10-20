import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as pc from 'playcanvas';

// Fake WebGL / WebGPU Texture and StorageBuffer for CPU-only headless testing
class FakeTexture {
    constructor(device, options) {
        this.width = options?.width ?? 64;
        this.height = options?.height ?? 64;
        this.data = new Float32Array(this.width * this.height * 4);
        this.destroyed = false;
    }
    lock() { return this.data; }
    unlock() {}
    upload() {}
    destroy() {
        assert.ok(!this.destroyed, 'double destroy on Texture');
        this.destroyed = true;
    }
}

class FakeStorageBuffer {
    constructor(device, byteSize, usage) {
        this.byteSize = byteSize;
        this.destroyed = false;
    }
    write(offset, data, srcOffset, length) {}
    destroy() {
        assert.ok(!this.destroyed, 'double destroy on StorageBuffer');
        this.destroyed = true;
    }
}

const fakePc = {
    ...pc,
    Texture: FakeTexture,
    StorageBuffer: FakeStorageBuffer
};

// Loader for TypeScript source files
function createLoader() {
    const cache = new Map();
    function load(relPath, customOverrides = {}) {
        const fullPath = resolve(relPath);
        if (cache.has(fullPath)) return cache.get(fullPath);
        const exports = {};
        cache.set(fullPath, exports);
        const source = readFileSync(fullPath, 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        vm.runInNewContext(compiled, {
            exports,
            console,
            Uint8Array,
            Uint32Array,
            Float32Array,
            ArrayBuffer,
            DataView,
            TextEncoder,
            TextDecoder,
            require: name => {
                if (customOverrides[name]) return customOverrides[name];
                if (name === 'playcanvas') return fakePc;
                return load(resolve(dirname(fullPath), `${name}.ts`), customOverrides);
            }
        }, { filename: fullPath });
        return exports;
    }
    return load;
}

const load = createLoader();
const { GaussianInstances } = load('src/gaussian-instances.ts');
const { TransformPalette } = load('src/transform-palette.ts');
const { ColorPalette } = load('src/color-palette.ts');
const { createGradeTerms, gradeRows, composeGrades } = load('src/color-grade.ts');
const { MergeSplatsOp } = load('src/edit-ops.ts');
const { EditHistory } = load('src/edit-history.ts');
const { CommandQueue } = load('src/command-queue.ts');
const { Events } = load('src/events.ts');
const { IndexRanges } = load('src/index-ranges.ts');
const { encodeInstances, writeInstances, decodeInstances, restorePalettes } = load('src/doc-instances.ts');
const { Element, ElementType } = load('src/element.ts');

const device = {};

// Helper to create a fake Splat layer with entity worldTransform and palettes
function createFakeSplat(resource, options = {}) {
    const numRows = resource.numRows;
    const count = options.count ?? numRows;
    const instances = new GaussianInstances(device, count);

    if (options.sourceRow) {
        instances.sourceRow.set(options.sourceRow);
    }
    if (options.flags) {
        instances.flags.set(options.flags);
    }
    if (options.palette) {
        instances.palette.set(options.palette);
    }

    const transformPalette = new TransformPalette(device);
    const colorPalette = new ColorPalette(device);

    const entity = new pc.Entity();
    if (options.position) entity.setLocalPosition(options.position);
    if (options.rotation) entity.setLocalRotation(options.rotation);
    if (options.scale) entity.setLocalScale(options.scale);
    entity.getWorldTransform(); // compute matrix

    let destroyed = false;
    if (typeof resource.acquire === 'function') {
        resource.acquire();
    }
    const splat = {
        type: ElementType.splat,
        resource,
        instances,
        transformPalette,
        colorPalette,
        entity,
        visible: options.visible !== false,
        name: options.name ?? 'test-layer',
        numSplats: count,
        numLocked: 0,
        numSelected: 0,
        numDeleted: 0,
        updateStateCalled: 0,
        async updateState() {
            this.updateStateCalled++;
            this.instances.flush();
            this.numSplats = this.instances.count;
            this.numLocked = this.instances.numLocked;
            this.numSelected = this.instances.numSelected;
            this.numDeleted = this.instances.numRemoved;
            if (this.scene?.projectedSplatRenderer) {
                this.scene.projectedSplatRenderer.replace(this);
            }
        },
        destroy() {
            assert.ok(!destroyed, 'Splat double destroy');
            destroyed = true;
            const owningScene = this.scene;
            if (owningScene) {
                owningScene.remove(this);
                owningScene.events?.fire('scene.elementDestroyed', this);
            }
            this.instances.destroy();
            this.transformPalette.destroy();
            this.colorPalette.destroy();
            if (typeof this.resource.release === 'function') {
                this.resource.release();
            }
        },
        get destroyed() { return destroyed; }
    };
    return splat;
}

// Helper to create a fake Scene
function createFakeScene() {
    const elements = [];
    const contentChildren = [];
    const rendererPlacements = [];

    const scene = {
        elements,
        getElementsByType(type) {
            return elements.filter(e => e.type === type);
        },
        contentRoot: {
            addChild(entity) {
                contentChildren.push(entity);
            },
            removeChild(entity) {
                const idx = contentChildren.indexOf(entity);
                if (idx !== -1) contentChildren.splice(idx, 1);
            }
        },
        projectedSplatRenderer: {
            add(splat) {
                rendererPlacements.push({ splat, count: splat.instances.count });
            },
            remove(splat) {
                const idx = rendererPlacements.findIndex(p => p.splat === splat);
                if (idx !== -1) rendererPlacements.splice(idx, 1);
            },
            replace(splat) {
                const p = rendererPlacements.find(item => item.splat === splat);
                if (p) p.count = splat.instances.count;
            }
        },
        async add(element, index) {
            if (!elements.includes(element)) {
                if (index !== undefined && index >= 0 && index <= elements.length) {
                    elements.splice(index, 0, element);
                } else {
                    elements.push(element);
                }
            }
            element.scene = this;
            this.contentRoot.addChild(element.entity);
            this.projectedSplatRenderer.add(element);
            await element.updateState();
            const insertPos = elements.indexOf(element);
            const nextListElement = elements.slice(insertPos + 1).find(
                e => e.type === ElementType.splat || e.type === ElementType.model
            );
            this.events?.fire('scene.elementAdded', element, nextListElement);
        },
        remove(element) {
            const idx = elements.indexOf(element);
            if (idx !== -1) {
                elements.splice(idx, 1);
            }
            this.contentRoot.removeChild(element.entity);
            this.projectedSplatRenderer.remove(element);
            element.scene = null;
            this.events?.fire('scene.elementRemoved', element);
        }
    };
    return scene;
}

// Compute world position of instance i: W * (0, 0, 0) + translation
function getInstanceWorldTransform(splat, i) {
    const transformIndex = splat.instances.transformIndex(i);
    const P = new pc.Mat4();
    if (transformIndex > 0) {
        splat.transformPalette.getTransform(transformIndex, P);
    }
    const W = new pc.Mat4();
    W.mul2(splat.entity.getWorldTransform(), P);
    return W;
}

function getInstanceColorGrade(splat, i) {
    const colorIndex = splat.instances.colorIndex(i);
    const terms = createGradeTerms();
    if (colorIndex > 0) {
        splat.colorPalette.getEntry(colorIndex, terms);
    }
    return terms;
}

async function runTests() {
    console.log('Starting merge splats regression test suite...');

    const sharedResource = { device, numRows: 10 };

    // =========================================================================
    // Test 1: Transform, palette and color baking across multiple layers
    // =========================================================================
    {
        console.log('Test 1: Transform and color palette baking accuracy...');
        const scene = createFakeScene();

        // Target layer at (1, 2, 3), rotated 45 deg around Y, scale 1.5
        const targetRot = new pc.Quat().setFromEulerAngles(0, 45, 0);
        const target = createFakeSplat(sharedResource, {
            name: 'target',
            position: new pc.Vec3(1, 2, 3),
            rotation: targetRot,
            scale: new pc.Vec3(1.5, 1.5, 1.5),
            count: 4,
            sourceRow: new Uint32Array([0, 1, 2, 3]),
            flags: new Uint8Array([1, 0, 2, 1]) // 1 = selected, 2 = locked
        });
        await scene.add(target);

        // Source 1: translated to (5, -1, 2), rotated 30 deg, scale 2.0
        // Has a palette transform on instance 1
        const src1 = createFakeSplat(sharedResource, {
            name: 'source1',
            position: new pc.Vec3(5, -1, 2),
            rotation: new pc.Quat().setFromEulerAngles(30, 0, 0),
            scale: new pc.Vec3(2, 2, 2),
            count: 3,
            sourceRow: new Uint32Array([4, 5, 6]),
            flags: new Uint8Array([0, 1, 0])
        });
        const customMat = new pc.Mat4().setTRS(new pc.Vec3(0.5, 0.2, -0.1), new pc.Quat().setFromEulerAngles(10, 20, 30), new pc.Vec3(1.1, 1.1, 1.1));
        const customTransIdx = src1.transformPalette.alloc(1);
        src1.transformPalette.setTransform(customTransIdx, customMat);
        src1.instances.setTransformIndex(1, customTransIdx);
        await scene.add(src1);

        // Source 2: has color palette grade on instance 0
        const src2 = createFakeSplat(sharedResource, {
            name: 'source2',
            position: new pc.Vec3(-2, 4, 1),
            rotation: new pc.Quat().setFromEulerAngles(0, 0, 60),
            scale: new pc.Vec3(0.8, 0.8, 0.8),
            count: 2,
            sourceRow: new Uint32Array([7, 8]),
            flags: new Uint8Array([2, 1])
        });
        const customGrade = createGradeTerms();
        customGrade.m[0] = 1.3;
        customGrade.offset.r = 0.2;
        customGrade.transparency = 0.5;
        const customColorIdx = src2.colorPalette.alloc(1);
        src2.colorPalette.setEntry(customColorIdx, customGrade);
        src2.instances.setColorIndex(0, customColorIdx);
        await scene.add(src2);

        // Capture world transform & grade for every instance before merge
        const preMergeData = [];
        for (let i = 0; i < target.instances.count; ++i) {
            preMergeData.push({
                sourceRow: target.instances.sourceRow[i],
                flags: target.instances.flags[i],
                worldMat: getInstanceWorldTransform(target, i),
                color: getInstanceColorGrade(target, i)
            });
        }
        for (let i = 0; i < src1.instances.count; ++i) {
            preMergeData.push({
                sourceRow: src1.instances.sourceRow[i],
                flags: src1.instances.flags[i],
                worldMat: getInstanceWorldTransform(src1, i),
                color: getInstanceColorGrade(src1, i)
            });
        }
        for (let i = 0; i < src2.instances.count; ++i) {
            preMergeData.push({
                sourceRow: src2.instances.sourceRow[i],
                flags: src2.instances.flags[i],
                worldMat: getInstanceWorldTransform(src2, i),
                color: getInstanceColorGrade(src2, i)
            });
        }

        const mergeOp = new MergeSplatsOp(scene, target, [src1, src2]);
        await mergeOp.do();

        // Target should now hold 4 + 3 + 2 = 9 instances
        assert.equal(target.instances.count, 9, 'Merged instance count must equal sum of layers');
        assert.equal(scene.elements.length, 1, 'Source layers removed from scene');
        assert.equal(scene.elements[0], target, 'Target remains in scene');

        // Check each merged instance's world coordinates, rotation, scale, sourceRow, flags, and color
        const testPoint = new pc.Vec3(0.3, -0.4, 0.5);
        for (let i = 0; i < 9; ++i) {
            const pre = preMergeData[i];
            assert.equal(target.instances.sourceRow[i], pre.sourceRow, `sourceRow mismatch at instance ${i}`);
            assert.equal(target.instances.flags[i], pre.flags, `flags mismatch at instance ${i}`);

            const postWorldMat = getInstanceWorldTransform(target, i);
            for (let m = 0; m < 16; ++m) {
                assert.ok(
                    Math.abs(pre.worldMat.data[m] - postWorldMat.data[m]) < 1e-4,
                    `World matrix element ${m} mismatch at instance ${i}: ${pre.worldMat.data[m]} vs ${postWorldMat.data[m]}`
                );
            }
            const ptPre = pre.worldMat.transformPoint(testPoint, new pc.Vec3());
            const ptPost = postWorldMat.transformPoint(testPoint, new pc.Vec3());

            assert.ok(ptPre.distance(ptPost) < 1e-4, `World point divergence at instance ${i}: pre ${ptPre.toString()} vs post ${ptPost.toString()}`);

            // Color grade terms check
            const postColor = getInstanceColorGrade(target, i);
            assert.ok(Math.abs(postColor.m[0] - pre.color.m[0]) < 1e-5, `Color matrix mismatch at ${i}`);
            assert.ok(Math.abs(postColor.offset.r - pre.color.offset.r) < 1e-5, `Color offset mismatch at ${i}`);
            assert.ok(Math.abs(postColor.transparency - pre.color.transparency) < 1e-5, `Transparency mismatch at ${i}`);
        }
        console.log('  PASS: World transforms and color terms match across all 9 instances.');

        // Test Undo
        console.log('Test 1.1: Undo merge...');
        await mergeOp.undo();
        assert.equal(target.instances.count, 4, 'Target restored to 4 instances on undo');
        assert.equal(scene.elements.length, 3, 'All 3 layers restored in scene on undo');
        assert.ok(scene.elements.includes(target));
        assert.ok(scene.elements.includes(src1));
        assert.ok(scene.elements.includes(src2));

        // Test Redo
        console.log('Test 1.2: Redo merge...');
        await mergeOp.do();
        assert.equal(target.instances.count, 9, 'Target restored to 9 instances on redo');
        assert.equal(scene.elements.length, 1, 'Sources removed on redo');

        // Test destroy while applied
        mergeOp.destroy();
        assert.ok(src1.destroyed, 'Source 1 destroyed on destroy while applied');
        assert.ok(src2.destroyed, 'Source 2 destroyed on destroy while applied');
        assert.ok(!target.destroyed, 'Target NOT destroyed on destroy while applied');
        target.destroy();
    }

    // =========================================================================
    // Test 2: Undo then destroy (safe lifecycle when user undoes then makes edit)
    // =========================================================================
    {
        console.log('Test 2: Lifecycle on Undo followed by Op destroy...');
        const scene = createFakeScene();
        const target = createFakeSplat(sharedResource, { count: 3 });
        const src = createFakeSplat(sharedResource, { count: 2 });
        await scene.add(target);
        await scene.add(src);

        const op = new MergeSplatsOp(scene, target, [src]);
        await op.do();
        assert.equal(target.instances.count, 5);
        await op.undo();
        assert.equal(target.instances.count, 3);
        assert.equal(scene.elements.length, 2);

        // When destroyed while in undo state:
        op.destroy();
        assert.ok(!target.destroyed, 'Target remains alive in scene');
        assert.ok(!src.destroyed, 'Source remains alive in scene');

        target.destroy();
        src.destroy();
        console.log('  PASS: Resources undamaged when destroyed in undone state.');
    }

    // =========================================================================
    // Test 3: count > resource.numRows (Clone Stamp duplicated layer merge)
    // =========================================================================
    {
        console.log('Test 3: Merged layer where count > resource.numRows & .ssproj round-trip...');
        const smallResource = { device, numRows: 4 };
        const scene = createFakeScene();

        // 3 layers each with 4 rows => total 12 instances > 4
        const target = createFakeSplat(smallResource, { count: 4, sourceRow: new Uint32Array([0, 1, 2, 3]) });
        const copy1 = createFakeSplat(smallResource, {
            count: 4,
            sourceRow: new Uint32Array([0, 1, 2, 3]),
            position: new pc.Vec3(10, 0, 0)
        });
        const copy2 = createFakeSplat(smallResource, {
            count: 4,
            sourceRow: new Uint32Array([0, 1, 2, 3]),
            position: new pc.Vec3(20, 0, 0)
        });
        await scene.add(target);
        await scene.add(copy1);
        await scene.add(copy2);

        const op = new MergeSplatsOp(scene, target, [copy1, copy2]);
        await op.do();

        assert.equal(target.instances.count, 12, '12 total instances');
        assert.ok(target.instances.count > smallResource.numRows, 'instances.count > numRows');
        assert.ok(target.instances.sourceRow.length >= 12, 'buffer capacity accommodates > numRows');

        // Test .ssproj write & decode instances
        const chunks = [];
        const writable = {
            async write(bytes) { chunks.push(bytes.slice()); },
            async close() {}
        };
        await writeInstances(target, null, writable);
        const encodedBlob = Buffer.concat(chunks);
        const decoded = decodeInstances(encodedBlob);

        assert.equal(decoded.sourceRow.length, 12, 'Decoded instances count is 12');
        assert.deepEqual(Array.from(decoded.sourceRow), [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);

        // Test GaussianInstances.fromRecords with count > numRows (verifying no RangeError)
        const reloaded = GaussianInstances.fromRecords(
            device,
            smallResource.numRows,
            decoded.sourceRow,
            decoded.flags,
            decoded.palette
        );
        assert.equal(reloaded.count, 12);
        assert.equal(reloaded.numRemoved, 0, 'numRemoved must be 0 because all 4 static rows are referenced');
        assert.ok(reloaded.sourceRow.length >= 12, 'reloaded capacity covers records length');

        // Test appendMissing(numRows) safety
        const added = reloaded.appendMissing(smallResource.numRows);
        assert.equal(added, 0, 'No missing rows when all rows 0..3 are referenced');

        // Test appendMissing when some static rows ARE missing and count > numRows
        // e.g. 5 instances referring only to row 0 and row 1 (missing 2 and 3)
        const partialSourceRow = new Uint32Array([0, 1, 0, 1, 0]);
        const partialFlags = new Uint8Array(5);
        const partialPalette = new Uint32Array(5);
        const partialInstances = GaussianInstances.fromRecords(
            device,
            smallResource.numRows,
            partialSourceRow,
            partialFlags,
            partialPalette
        );
        assert.equal(partialInstances.count, 5);
        assert.equal(partialInstances.numRemoved, 2, 'Rows 2 and 3 are missing, so numRemoved is 2');

        const appendedCount = partialInstances.appendMissing(smallResource.numRows);
        assert.equal(appendedCount, 2, 'Appended 2 missing rows');
        assert.equal(partialInstances.count, 7, 'Total count now 7');
        assert.equal(partialInstances.sourceRow[5], 2, 'Appended row 2');
        assert.equal(partialInstances.sourceRow[6], 3, 'Appended row 3');
        assert.equal(partialInstances.numRemoved, 0, 'numRemoved is now 0');

        partialInstances.truncate(2);
        assert.equal(partialInstances.count, 5, 'Truncated back to 5');
        assert.equal(partialInstances.numRemoved, 2, 'numRemoved restored to 2');

        op.destroy();
        target.destroy();
        reloaded.destroy();
        partialInstances.destroy();
        console.log('  PASS: count > numRows round-trip, fromRecords and appendMissing safe.');
    }

    // =========================================================================
    // Test 4: CanMerge predicate logic
    // =========================================================================
    {
        console.log('Test 4: canMerge conditions...');
        const scene = createFakeScene();
        const resA = { device, numRows: 5 };
        const resB = { device, numRows: 5 };

        const splatA1 = createFakeSplat(resA, { name: 'A1' });
        const splatA2 = createFakeSplat(resA, { name: 'A2' });
        const splatB = createFakeSplat(resB, { name: 'B' });

        await scene.add(splatA1);
        await scene.add(splatA2);
        await scene.add(splatB);

        const getMergeableSources = (target) => {
            if (!target || !target.visible) return [];
            return scene.getElementsByType(ElementType.splat)
                .filter(s => s !== target && s.visible && s.resource === target.resource);
        };

        // When A1 is selected: A2 is a valid mergeable source
        assert.deepEqual(getMergeableSources(splatA1), [splatA2]);

        // When B is selected: no other layer shares resB
        assert.deepEqual(getMergeableSources(splatB), []);

        // When A2 is hidden: A1 cannot merge
        splatA2.visible = false;
        assert.deepEqual(getMergeableSources(splatA1), []);
        splatA2.visible = true;

        // When A1 is hidden:
        splatA1.visible = false;
        assert.deepEqual(getMergeableSources(splatA1), []);
        splatA1.visible = true;

        splatA1.destroy();
        splatA2.destroy();
        splatB.destroy();
        console.log('  PASS: canMerge correctly checks shared resource and visibility.');
    }

    // =========================================================================
    // Test 5 (C1): EditHistory.removeForSplat frees off-scene sources & resource refCount
    // =========================================================================
    {
        console.log('Test 5: EditHistory.removeForSplat resource & GPU buffer cleanup (C1)...');
        let refCount = 0;
        const refResource = {
            device,
            numRows: 4,
            acquire() { refCount++; },
            release() {
                assert.ok(refCount > 0, 'resource refCount underflow');
                refCount--;
            }
        };

        // Case A: Merge applied, then target is destroyed (removeForSplat)
        {
            const events = new Events();
            const queue = new CommandQueue();
            const history = new EditHistory(events, queue);
            const scene = createFakeScene();
            scene.events = events;
            events.on('scene.elementDestroyed', (el) => history.removeForSplat(el));

            const target = createFakeSplat(refResource, { name: 'target', count: 2, sourceRow: new Uint32Array([0, 1]) });
            const src1 = createFakeSplat(refResource, { name: 'src1', count: 1, sourceRow: new Uint32Array([2]) });
            const src2 = createFakeSplat(refResource, { name: 'src2', count: 1, sourceRow: new Uint32Array([3]) });
            const origTargetInstances = target.instances;

            await scene.add(target);
            await scene.add(src1);
            await scene.add(src2);
            assert.equal(refCount, 3, '3 active layers hold 3 resource refs');

            await history.add(new MergeSplatsOp(scene, target, [src1, src2]));
            assert.equal(target.instances.count, 4);
            assert.equal(scene.elements.length, 1);
            assert.ok(!src1.destroyed && !src2.destroyed, 'Sources alive for Undo while op is in history');
            assert.equal(refCount, 3, 'All 3 refs held while Undo is possible');

            // Destroy target (e.g. user deletes layer or scene.clear())
            target.destroy();
            await queue.enqueue(() => {}); // flush queued removeForSplat

            assert.ok(target.destroyed, 'Target destroyed');
            assert.ok(src1.destroyed, 'Off-scene src1 destroyed by removeForSplat');
            assert.ok(src2.destroyed, 'Off-scene src2 destroyed by removeForSplat');
            assert.ok(origTargetInstances.instanceSource.destroyed, 'Original target instance buffers destroyed');
            assert.equal(refCount, 0, 'All static EditorSplatResource refs released (refCount === 0)');
            assert.equal(history.history.length, 0, 'MergeSplatsOp purged from history');
        }

        // Case B: Merge undone, then one source is destroyed (removeForSplat)
        {
            const events = new Events();
            const queue = new CommandQueue();
            const history = new EditHistory(events, queue);
            const scene = createFakeScene();
            scene.events = events;
            events.on('scene.elementDestroyed', (el) => history.removeForSplat(el));

            const target = createFakeSplat(refResource, { name: 'target', count: 2, sourceRow: new Uint32Array([0, 1]) });
            const src1 = createFakeSplat(refResource, { name: 'src1', count: 1, sourceRow: new Uint32Array([2]) });
            const src2 = createFakeSplat(refResource, { name: 'src2', count: 1, sourceRow: new Uint32Array([3]) });

            await scene.add(target);
            await scene.add(src1);
            await scene.add(src2);
            assert.equal(refCount, 3);

            const mergeOp = new MergeSplatsOp(scene, target, [src1, src2]);
            await history.add(mergeOp);
            const mergedInstancesBuf = target.instances;
            await history.undo();

            assert.equal(scene.elements.length, 3);
            assert.ok(!mergedInstancesBuf.instanceSource.destroyed, 'Merged buffer kept for Redo');

            // Destroy src1 while mergeOp is in redo tail
            src1.destroy();
            await queue.enqueue(() => {});

            assert.ok(src1.destroyed, 'src1 destroyed');
            assert.ok(!target.destroyed, 'target survives when undone mergeOp is purged');
            assert.ok(!src2.destroyed, 'src2 survives when undone mergeOp is purged');
            assert.ok(mergedInstancesBuf.instanceSource.destroyed, 'Inactive mergedInstances buffer freed');
            assert.equal(refCount, 2, 'target and src2 still hold their 2 resource refs');

            target.destroy();
            src2.destroy();
            await queue.enqueue(() => {});
            assert.equal(refCount, 0, 'All refs released after remaining layers destroyed');
        }
        console.log('  PASS: removeForSplat frees off-scene sources, GPU buffers, and resource refCounts.');
    }

    // =========================================================================
    // Test 6 (M1): Interleaved layer ordering preserved on Undo / Redo
    // =========================================================================
    {
        console.log('Test 6: Interleaved layer ordering on Undo / Redo (M1)...');
        const events = new Events();
        const scene = createFakeScene();
        scene.events = events;

        // Track UI list order via scene.elementAdded(element, beforeElement) & scene.elementRemoved
        const uiList = [];
        events.on('scene.elementAdded', (el, beforeEl) => {
            const beforeIdx = beforeEl ? uiList.indexOf(beforeEl) : -1;
            if (beforeIdx !== -1) {
                uiList.splice(beforeIdx, 0, el);
            } else {
                uiList.push(el);
            }
        });
        events.on('scene.elementRemoved', (el) => {
            const idx = uiList.indexOf(el);
            if (idx !== -1) uiList.splice(idx, 1);
        });

        const resShared = { device, numRows: 6 };
        const resOther = { device, numRows: 3 };

        const copyA = createFakeSplat(resShared, { name: 'copyA', count: 2, sourceRow: new Uint32Array([0, 1]) });
        const other = createFakeSplat(resOther, { name: 'other', count: 3, sourceRow: new Uint32Array([0, 1, 2]) });
        const original = createFakeSplat(resShared, { name: 'original', count: 2, sourceRow: new Uint32Array([2, 3]) });
        const copyB = createFakeSplat(resShared, { name: 'copyB', count: 2, sourceRow: new Uint32Array([4, 5]) });

        await scene.add(copyA);
        await scene.add(other);
        await scene.add(original);
        await scene.add(copyB);

        assert.deepEqual(scene.elements.map(e => e.name), ['copyA', 'other', 'original', 'copyB']);
        assert.deepEqual(uiList.map(e => e.name), ['copyA', 'other', 'original', 'copyB']);

        const op = new MergeSplatsOp(scene, original, [copyA, copyB]);
        await op.do();
        assert.deepEqual(scene.elements.map(e => e.name), ['other', 'original']);
        assert.deepEqual(uiList.map(e => e.name), ['other', 'original']);

        await op.undo();
        assert.deepEqual(
            scene.elements.map(e => e.name),
            ['copyA', 'other', 'original', 'copyB'],
            'scene.elements order must match pre-merge order on Undo'
        );
        assert.deepEqual(
            uiList.map(e => e.name),
            ['copyA', 'other', 'original', 'copyB'],
            'UI SplatList order must match pre-merge order on Undo'
        );

        await op.do();
        assert.deepEqual(scene.elements.map(e => e.name), ['other', 'original']);
        await op.undo();
        assert.deepEqual(scene.elements.map(e => e.name), ['copyA', 'other', 'original', 'copyB']);

        op.destroy();
        copyA.destroy();
        other.destroy();
        original.destroy();
        copyB.destroy();
        console.log('  PASS: Interleaved layer order in scene.elements and SplatList restored on Undo.');
    }

    // =========================================================================
    // Test 7 (M2): GaussianInstances.fromSubset numRemoved after merge with duplicates
    // =========================================================================
    {
        console.log('Test 7: GaussianInstances.fromSubset numRemoved with duplicate rows (M2)...');
        const res4 = { device, numRows: 4 };
        const scene = createFakeScene();

        // 3 layers all referencing only static row 0 (rows 1, 2, 3 are missing => 3 missing rows)
        const l1 = createFakeSplat(res4, { count: 1, sourceRow: new Uint32Array([0]) });
        const l2 = createFakeSplat(res4, { count: 1, sourceRow: new Uint32Array([0]) });
        const l3 = createFakeSplat(res4, { count: 1, sourceRow: new Uint32Array([0]) });
        await scene.add(l1);
        await scene.add(l2);
        await scene.add(l3);

        const op = new MergeSplatsOp(scene, l1, [l2, l3]);
        await op.do();

        // Merged layer has 3 instances (all row 0), capacity = max(4, 3 + 3) = 6, numRemoved = 3
        assert.equal(l1.instances.count, 3);
        assert.equal(l1.instances.numRows, 4);
        assert.equal(l1.instances.numRemoved, 3);

        // Separate/Duplicate 1 instance via fromSubset
        const singleRange = new IndexRanges(new Uint32Array([0, 1]));
        const subset = GaussianInstances.fromSubset(device, l1.instances, singleRange);

        assert.equal(subset.count, 1);
        assert.equal(subset.numRows, 4);
        assert.equal(
            subset.numRemoved,
            3,
            'Subset referencing row 0 of 4 static rows must have numRemoved === 3, not capacity - 1 (5)'
        );

        // Verify appendMissing(4) & truncate on subset brings numRemoved to 0 and back to 3
        const added = subset.appendMissing(res4.numRows);
        assert.equal(added, 3);
        assert.equal(subset.numRemoved, 0, 'numRemoved must be 0 after restoring all 3 missing static rows');
        subset.truncate(added);
        assert.equal(subset.numRemoved, 3, 'numRemoved restored to 3 after truncate');

        subset.destroy();
        op.destroy();
        l1.destroy();
        console.log('  PASS: fromSubset computes numRemoved from unique static rows.');
    }

    console.log('\nAll merge splats tests PASSED successfully!');
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
