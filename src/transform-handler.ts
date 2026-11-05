import { ElementType } from './element';
import { EntityTransformHandler } from './entity-transform-handler';
import type { Events } from './events';
import type { GltfModel } from './model';
import { registerPivotEvents } from './pivot';
import type { Splat } from './splat';
import { SplatsTransformHandler } from './splats-transform-handler';

interface TransformHandler {
    activate: () => void;
    deactivate: () => void;
}

const registerTransformHandlerEvents = (events: Events) => {
    const transformHandlers: TransformHandler[] = [];

    const push = (handler: TransformHandler) => {
        if (transformHandlers.length > 0 && transformHandlers[transformHandlers.length - 1] === handler) {
            return;
        }
        if (transformHandlers.length > 0) {
            const transformHandler = transformHandlers[transformHandlers.length - 1];
            transformHandler.deactivate();
        }
        transformHandlers.push(handler);
        handler.activate();
    };

    const pop = (targetHandler?: TransformHandler) => {
        if (transformHandlers.length === 0) {
            return;
        }
        if (targetHandler && transformHandlers[transformHandlers.length - 1] !== targetHandler) {
            const idx = transformHandlers.lastIndexOf(targetHandler);
            if (idx >= 0) {
                transformHandlers.splice(idx, 1);
                targetHandler.deactivate();
            }
            return;
        }

        const transformHandler = transformHandlers.pop();
        transformHandler.deactivate();

        if (transformHandlers.length > 0) {
            const nextHandler = transformHandlers[transformHandlers.length - 1];
            nextHandler.activate();
        }
    };

    // bind transform target when selection changes
    const entityTransformHandler = new EntityTransformHandler(events);
    const splatsTransformHandler = new SplatsTransformHandler(events);

    const isBaseHandler = (handler: TransformHandler) => {
        return handler === entityTransformHandler || handler === splatsTransformHandler;
    };

    const update = (splat: Splat | GltfModel) => {
        const nextBaseHandler = splat
            ? splat.type === ElementType.splat && (splat as Splat).numSelected > 0
                ? splatsTransformHandler
                : entityTransformHandler
            : null;

        const hasOverlayTool =
            transformHandlers.length > 0 && !isBaseHandler(transformHandlers[transformHandlers.length - 1]);

        if (hasOverlayTool) {
            const currentBase =
                transformHandlers.length > 0 && isBaseHandler(transformHandlers[0]) ? transformHandlers[0] : null;

            if (currentBase !== nextBaseHandler) {
                if (currentBase) {
                    currentBase.deactivate();
                    transformHandlers.shift();
                }
                if (nextBaseHandler) {
                    transformHandlers.unshift(nextBaseHandler);
                }
            }
        } else {
            while (transformHandlers.length > 0) {
                const handler = transformHandlers.pop();
                handler.deactivate();
            }
            if (nextBaseHandler) {
                push(nextBaseHandler);
            }
        }
    };

    events.on('selection.changed', update);
    events.on('splat.stateChanged', update);

    events.on('transformHandler.push', (handler: TransformHandler) => {
        push(handler);
    });

    events.on('transformHandler.pop', (handler?: TransformHandler) => {
        pop(handler);
    });

    registerPivotEvents(events);
};

export { registerTransformHandlerEvents, TransformHandler };
