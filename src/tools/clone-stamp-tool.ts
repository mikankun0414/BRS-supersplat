import { Container, Label } from '@playcanvas/pcui';
import { BoundingBox, Mat4, Vec3 } from 'playcanvas';

import { AddSplatOp, selectedRanges } from '../edit-ops';
import { ElementType } from '../element';
import { Events } from '../events';
import { IndexRanges } from '../index-ranges';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { ToolOverlay, OverlayWriter } from '../tool-overlay';
import { i18n } from '../ui/localization';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

const mat = new Mat4();
const delta = new Vec3();

// The local position that moves a layer by (target - anchor) in world space.
// The layer's local position lives in its parent's space, so the world offset is
// carried into that space first - a plain add is only right while the parent has
// no rotation or scale. Exported separately so the math can be checked without
// constructing the tool.
const stampPosition = (localPosition: Vec3, anchor: Vec3, target: Vec3, parentWorld: Mat4, result = new Vec3()) => {
    delta.sub2(target, anchor);
    mat.invert(parentWorld);
    mat.transformVector(delta, delta);
    return result.add2(localPosition, delta);
};

class CloneStampTransformHandler {
    activate() {}
    deactivate() {}
}

// Capture the selected gaussians as an immutable template. Each click places
// its bounding-box center on the picked surface, adding one layer / undo step.
// Alt+click refreshes the selection; the click position never chooses a pivot.
class CloneStampTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const hintLabel = new Label({ class: 'select-toolbar-label' });

        const selectToolbar = new Container({
            class: ['select-toolbar', 'select-toolbar-tool'],
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        selectToolbar.append(hintLabel);
        canvasContainer.append(selectToolbar);

        const transformHandler = new CloneStampTransformHandler();

        let active = false;

        // The source is captured as a template: a layer over the selected
        // instances, never added to the scene. Stamps copy the template, so
        // editing, moving, hiding or frame-swapping the original layer
        // afterwards does not change what lands - like sampling in Photoshop.
        // Bounds belong to the captured instances, including their palette edits.
        let template: Splat = null;
        const anchor = new Vec3();
        const center = new Vec3();
        let pendingCapture: Promise<boolean> = null;

        // createLayer copies LOCAL TRS and leaves the entity unparented. Its
        // worldTransform is therefore local-to-contentRoot, not source-to-world.
        const worldCenter = () => {
            template.worldTransform.transformPoint(center, anchor);
            return scene.contentRoot.getWorldTransform().transformPoint(anchor, anchor);
        };

        // bumped whenever the source changes or the tool closes, so a pick that
        // was in flight across that change is dropped
        let generation = 0;

        let hintKey = 'clone-stamp.hint-source';
        const setHint = (key: string) => {
            hintKey = key;
            hintLabel.text = i18n.t(hintKey);
        };
        i18n.bindText(hintLabel, () => i18n.t(hintKey));

        const clearSource = () => {
            generation++;
            template?.destroy();
            template = null;
            pendingCapture = null;
            scene.forceRender = true;
        };

        // the template holds a reference on the document's data
        events.on('scene.clear', () => {
            clearSource();
            setHint('clone-stamp.hint-source');
        });

        // the source point renders in the scene via the shared tool overlay
        const overlay = new ToolOverlay();
        overlay.provider = (writer: OverlayWriter) => {
            if (active && template) {
                writer.dot(worldCenter());
            }
        };

        // Snapshot synchronously, then calculate fresh bounds on that isolated
        // subset through the shared GPU queue. Source selectionBound is an async
        // cache and may still describe the previous selection / palette edits.
        const captureSelectionCenter = (): Promise<boolean> => {
            clearSource();
            const gen = generation;
            const splat = events.invoke('selection') as Splat;
            const ranges = splat?.type === ElementType.splat ? selectedRanges(splat) : null;
            if (!ranges || ranges.count === 0) {
                setHint('clone-stamp.no-selection');
                pendingCapture = null;
                return Promise.resolve(false);
            }

            const captured = splat.createLayer(ranges, splat.name);
            const selectionBound = new BoundingBox();
            const localBound = new BoundingBox();
            let accepted = false;
            const capture = scene.commandQueue.enqueue(async () => {
                if (gen !== generation) return false;
                // Subset creation and palette remapping leave dirty GPU buffers.
                captured.instances.flush();
                await scene.dataProcessor.calcBound(captured, selectionBound, localBound);
                if (gen !== generation) return false;
                center.copy(localBound.center);
                template = captured;
                accepted = true;
                setHint('clone-stamp.hint-stamp');
                scene.forceRender = true;
                return true;
            }).catch((error) => {
                console.error('Clone stamp source capture failed', error);
                if (gen === generation) setHint('clone-stamp.hint-source');
                return false;
            }).finally(() => {
                // Never destroy buffers while a queued GPU readback uses them.
                if (!accepted) captured.destroy();
                if (pendingCapture === capture) pendingCapture = null;
            });
            pendingCapture = capture;
            return capture;
        };

        const stamp = async (x: number, y: number) => {
            // Capture the gesture's camera before waiting for the source readback.
            const { camera } = scene;
            const pose = {
                position: camera.mainCamera.getPosition().clone(),
                rotation: camera.mainCamera.getRotation().clone(),
                orthoHeight: camera.camera.orthoHeight,
                near: camera.near,
                far: camera.far
            };
            const capture = pendingCapture ?? (!template ? captureSelectionCenter() : null);
            const gen = generation;
            if (capture && !await capture) return;
            if (gen !== generation || !template) return;

            const [result] = await camera.intersectMany([{ x, y }], undefined, pose);
            if (gen !== generation || !result || !template) return;

            const copy = template.createLayer(IndexRanges.fromPredicate(template.instances.count, () => true), template.name);
            // Both template and copy retain the source's local rotation / scale.
            // Recompute the world center under the destination parent, including
            // any parent movement since capture, before translating the copy.
            const position = stampPosition(
                template.entity.getLocalPosition(), worldCenter(), result.position,
                scene.contentRoot.getWorldTransform()
            );
            copy.entity.setLocalPosition(position);

            const prevSelection = events.invoke('selection') as Splat;
            events.fire('edit.add', new AddSplatOp(scene, copy));
            if (prevSelection && prevSelection.scene) {
                events.fire('selection', prevSelection);
            }
        };

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        let clicked = false;
        let clickClientX = 0;
        let clickClientY = 0;
        let clickAlt = false;

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
                clickClientX = e.clientX;
                clickClientY = e.clientY;
                clickAlt = e.altKey;
            }
        };

        const pointermove = (e: PointerEvent) => {
            // forgive small jitter between down and up; only a real drag cancels the click
            if (clicked && Math.hypot(e.clientX - clickClientX, e.clientY - clickClientY) > CLICK_TOLERANCE) {
                clicked = false;
            }
        };

        const pointerup = (e: PointerEvent) => {
            if (clicked && isPrimary(e)) {
                clicked = false;

                const rect = scene.canvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    // act at the pointer-down position: that is where the user aimed
                    const x = (clickClientX - rect.left) / rect.width;
                    const y = (clickClientY - rect.top) / rect.height;
                    if (clickAlt || e.altKey) {
                        captureSelectionCenter();
                    } else {
                        stamp(x, y);
                    }
                }

                // let the release through: the camera controller tracks the held
                // button and would otherwise ignore the next press
                e.preventDefault();
            }
        };

        this.activate = () => {
            active = true;
            setHint(template ? 'clone-stamp.hint-stamp' : 'clone-stamp.hint-source');
            if (!template && !pendingCapture) {
                captureSelectionCenter();
            }
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = false;

            events.fire('transformHandler.push', transformHandler);

            scene.add(overlay);

            scene.forceRender = true;
        };

        this.deactivate = () => {
            active = false;
            clicked = false;

            // drop picks still in flight; the source itself is kept for next time
            generation++;
            // The cancelled job still owns its buffers until its readback ends,
            // but a reactivated tool must start and await a fresh capture.
            pendingCapture = null;

            scene.remove(overlay);

            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = true;

            events.fire('transformHandler.pop');

            scene.forceRender = true;
        };
    }
}

export { CloneStampTool, stampPosition };
