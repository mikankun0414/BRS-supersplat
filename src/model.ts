import { Asset, BoundingBox, ContainerResource, Entity, LightComponent, MeshInstance, Quat, RenderComponent, Vec3 } from 'playcanvas';

import { Element, ElementType } from './element';
import { Serializer } from './serializer';
import { Transform } from './transform';

class GltfModel extends Element {
    asset: Asset;
    entity: Entity = null;
    worldBoundStorage = new BoundingBox();

    private _name: string;
    private _visible = true;
    private cleanup: () => void;
    private assetReleased = false;

    constructor(asset: Asset, cleanup: () => void) {
        super(ElementType.model);
        this.asset = asset;
        this.cleanup = cleanup;

        const file = asset.file as { filename?: string };
        this._name = file?.filename ?? asset.name;
    }

    add() {
        const scene = this.scene;

        try {
            const resource = this.asset.resource as ContainerResource;
            if (!resource?.instantiateRenderEntity) {
                throw new Error(`Unable to instantiate glTF model '${this.name}'.`);
            }

            this.entity = resource.instantiateRenderEntity({
                layers: [scene.modelLayer.id],
                castShadows: false
            });
            this.entity.name = this.name;
            scene.contentRoot.addChild(this.entity);

            // Keep lights embedded in a glTF on the model layer so they do not
            // unexpectedly illuminate splats or editor overlays.
            (this.entity.findComponents('render') as RenderComponent[]).forEach((render) => {
                render.layers = [scene.modelLayer.id];
            });
            (this.entity.findComponents('light') as LightComponent[]).forEach((light) => {
                light.layers = [scene.modelLayer.id];
            });

            this.entity.syncHierarchy();
            if (!this.updateWorldBound()) {
                throw new Error(`The glTF model '${this.name}' contains no renderable geometry.`);
            }

            this.entity.enabled = this.visible;
            const hasExistingRenderable =
                scene.getElementsByType(ElementType.model).length > 0 ||
                scene.getElementsByType(ElementType.splat).length > 0;

            scene.boundDirty = true;

            // A newly opened model should be visible even when its source units
            // or origin are very different from the default camera framing.
            if (!hasExistingRenderable) {
                const focusAfterAdd = (element: Element) => {
                    if (element !== this) {
                        return;
                    }

                    scene.events.off('scene.elementAdded', focusAfterAdd);
                    scene.boundDirty = true;
                    const sceneBound = scene.bound;
                    scene.camera.focus({
                        focalPoint: this.worldBound.center,
                        radius: Math.max(this.worldBound.halfExtents.length(), sceneBound.halfExtents.length()),
                        speed: 0
                    });
                    scene.forceRender = true;
                };
                scene.events.on('scene.elementAdded', focusAfterAdd);
            }
        } catch (error) {
            this.removeEntity();
            this.releaseAsset();
            throw error;
        }
    }

    remove() {
        const scene = this.scene;
        this.removeEntity();
        if (scene) {
            scene.boundDirty = true;
        }
        this.releaseAsset();
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.visible);
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        if (position) {
            this.entity.setLocalPosition(position);
        }
        if (rotation) {
            this.entity.setLocalRotation(rotation);
        }
        if (scale) {
            this.entity.setLocalScale(scale);
        }

        this.entity.syncHierarchy();
        this.updateWorldBound();
        this.scene.forceRender = true;
        this.scene.events.fire('model.moved', this);
    }

    // Return the model entity transform in the same content-root space used by
    // the transform gizmos and the numeric transform panel.
    getPivot(result: Transform) {
        result.set(
            this.entity.getLocalPosition(),
            this.entity.getLocalRotation(),
            this.entity.getLocalScale()
        );
    }

    get worldBound() {
        return this.worldBoundStorage;
    }

    set name(value: string) {
        if (value !== this.name) {
            this._name = value;
            this.scene?.events.fire('model.name', this);
        }
    }

    get name() {
        return this._name;
    }

    get filename() {
        const file = this.asset.file as { filename?: string };
        return file?.filename ?? this.name;
    }

    set visible(value: boolean) {
        if (value !== this.visible) {
            this._visible = value;
            if (this.entity) {
                this.entity.enabled = value;
            }
            this.scene?.events.fire('model.visibility', this);
            if (this.scene) {
                this.scene.forceRender = true;
            }
        }
    }

    get visible() {
        return this._visible;
    }

    private getMeshInstances() {
        return (this.entity.findComponents('render') as RenderComponent[])
        .flatMap(render => render.meshInstances as MeshInstance[]);
    }

    // Mesh editing and other model tools need access to the render instances,
    // while keeping the entity hierarchy owned by the model element.
    get meshInstances() {
        return this.entity ? this.getMeshInstances() : [];
    }

    // Refresh the bounds after an in-place mesh edit. Mesh.update() updates the
    // mesh AABB, but the element's aggregate bound is cached separately.
    refreshWorldBound() {
        if (!this.entity) {
            return;
        }

        this.entity.syncHierarchy();
        this.updateWorldBound();
        if (this.scene) {
            this.scene.events.fire('model.geometryChanged', this);
            this.scene.forceRender = true;
        }
    }

    private updateWorldBound() {
        const meshInstances = this.getMeshInstances();
        if (meshInstances.length === 0) {
            this.worldBoundStorage.center.set(0, 0, 0);
            this.worldBoundStorage.halfExtents.set(0, 0, 0);
            return false;
        }

        this.worldBoundStorage.copy(meshInstances[0].aabb);
        for (let i = 1; i < meshInstances.length; i++) {
            this.worldBoundStorage.add(meshInstances[i].aabb);
        }

        if (this.scene) {
            this.scene.boundDirty = true;
        }
        return true;
    }

    private removeEntity() {
        if (!this.entity) {
            return;
        }

        this.scene?.contentRoot.removeChild(this.entity);
        this.entity.destroy();
        this.entity = null;
    }

    private releaseAsset() {
        if (this.assetReleased) {
            return;
        }
        this.assetReleased = true;

        const registry = this.asset.registry;
        registry?.remove(this.asset);
        try {
            this.asset.unload();
        } finally {
            this.cleanup();
        }
    }
}

export { GltfModel };
