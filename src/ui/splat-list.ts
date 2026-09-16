import { Container, Label, Element as PcuiElement, TextInput } from '@playcanvas/pcui';

import { SplatRenameOp } from '../edit-ops';
import { Element, ElementType } from '../element';
import { Events } from '../events';
import { GltfModel } from '../model';
import { Splat } from '../splat';
import deleteSvg from './svg/delete.svg';
import hiddenSvg from './svg/hidden.svg';
import shownSvg from './svg/shown.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class SplatItem extends Container {
    getName: () => string;
    setName: (value: string) => void;
    getSelected: () => boolean;
    setSelected: (value: boolean) => void;
    getVisible: () => boolean;
    setVisible: (value: boolean) => void;
    destroy: () => void;

    constructor(name: string, edit: TextInput, args = {}) {
        args = {
            ...args,
            class: ['splat-item', 'visible']
        };

        super(args);

        const text = new Label({
            class: 'splat-item-text',
            text: name
        });

        const visible = new PcuiElement({
            dom: createSvg(shownSvg),
            class: 'splat-item-visible'
        });

        const invisible = new PcuiElement({
            dom: createSvg(hiddenSvg),
            class: 'splat-item-visible',
            hidden: true
        });

        const remove = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'splat-item-delete'
        });

        this.append(text);
        this.append(visible);
        this.append(invisible);
        this.append(remove);

        this.getName = () => {
            return text.value;
        };

        this.setName = (value: string) => {
            text.value = value;
        };

        this.getSelected = () => {
            return this.class.contains('selected');
        };

        this.setSelected = (value: boolean) => {
            if (value !== this.selected) {
                if (value) {
                    this.class.add('selected');
                    this.emit('select', this);
                } else {
                    this.class.remove('selected');
                    this.emit('unselect', this);
                }
            }
        };

        this.getVisible = () => {
            return this.class.contains('visible');
        };

        this.setVisible = (value: boolean) => {
            if (value !== this.visible) {
                visible.hidden = !value;
                invisible.hidden = value;
                if (value) {
                    this.class.add('visible');
                    this.emit('visible', this);
                } else {
                    this.class.remove('visible');
                    this.emit('invisible', this);
                }
            }
        };

        const toggleVisible = (event: MouseEvent) => {
            event.stopPropagation();
            this.visible = !this.visible;
        };

        const handleRemove = (event: MouseEvent) => {
            event.stopPropagation();
            this.emit('removeClicked', this);
        };

        // rename on double click
        text.dom.addEventListener('dblclick', (event: MouseEvent) => {
            event.stopPropagation();

            const onblur = () => {
                this.remove(edit);
                this.emit('rename', edit.value);
                edit.input.removeEventListener('blur', onblur);
                text.hidden = false;
            };

            text.hidden = true;

            this.appendAfter(edit, text);
            edit.value = text.value;
            edit.input.addEventListener('blur', onblur);
            edit.focus();
        });

        // handle clicks
        visible.dom.addEventListener('click', toggleVisible);
        invisible.dom.addEventListener('click', toggleVisible);
        remove.dom.addEventListener('click', handleRemove);

        this.destroy = () => {
            visible.dom.removeEventListener('click', toggleVisible);
            invisible.dom.removeEventListener('click', toggleVisible);
            remove.dom.removeEventListener('click', handleRemove);
        };
    }

    set name(value: string) {
        this.setName(value);
    }

    get name() {
        return this.getName();
    }

    set selected(value) {
        this.setSelected(value);
    }

    get selected() {
        return this.getSelected();
    }

    set visible(value) {
        this.setVisible(value);
    }

    get visible() {
        return this.getVisible();
    }
}

type SceneListElement = Splat | GltfModel;

class SplatList extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            class: 'splat-list'
        };

        super(args);

        const items = new Map<SceneListElement, SplatItem>();
        let soloMode = false;
        const savedVisibility = new Map<Splat, boolean>();

        // edit input used during renames
        const edit = new TextInput({
            id: 'splat-edit'
        });

        events.on('scene.elementAdded', (element: Element) => {
            if (element.type !== ElementType.splat && element.type !== ElementType.model) {
                return;
            }

            const sceneElement = element as SceneListElement;
            const item = new SplatItem(sceneElement.name, edit);
            this.append(item);
            items.set(sceneElement, item);

            if (sceneElement.type === ElementType.splat) {
                const splat = sceneElement as Splat;
                if (soloMode) {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = false;
                }

                item.on('visible', () => {
                    splat.visible = true;

                    // also select it if there is no other selection
                    if (!events.invoke('selection')) {
                        events.fire('selection', splat);
                    }
                });
                item.on('invisible', () => {
                    splat.visible = false;
                });
                item.on('rename', (value: string) => {
                    events.fire('edit.add', new SplatRenameOp(splat, value));
                });
            } else {
                const model = sceneElement as GltfModel;
                item.on('visible', () => {
                    model.visible = true;
                });
                item.on('invisible', () => {
                    model.visible = false;
                });
                item.on('rename', (value: string) => {
                    model.name = value;
                });
            }

            item.visible = sceneElement.visible;
        });

        events.on('scene.elementRemoved', (element: Element) => {
            if (element.type !== ElementType.splat && element.type !== ElementType.model) {
                return;
            }

            const sceneElement = element as SceneListElement;
            const item = items.get(sceneElement);
            if (item) {
                this.remove(item);
                item.destroy();
                items.delete(sceneElement);
            }
            if (sceneElement.type === ElementType.splat) {
                savedVisibility.delete(sceneElement as Splat);
            }
        });

        events.on('selection.changed', (selection: SceneListElement, prev: SceneListElement) => {
            items.forEach((value, key) => {
                value.selected = key === selection;
            });

            if (soloMode) {
                if (prev?.type === ElementType.splat) {
                    (prev as Splat).visible = false;
                }
                if (selection?.type === ElementType.splat) {
                    (selection as Splat).visible = true;
                }
            }
        });

        events.on('scene.solo', (value: boolean) => {
            soloMode = value;
            const selection = events.invoke('selection') as Splat;

            if (soloMode) {
                items.forEach((item, element) => {
                    if (element.type !== ElementType.splat) {
                        return;
                    }
                    const splat = element as Splat;
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = splat === selection;
                });
            } else {
                items.forEach((item, element) => {
                    if (element.type !== ElementType.splat) {
                        return;
                    }
                    const splat = element as Splat;
                    const wasVisible = savedVisibility.get(splat);
                    splat.visible = wasVisible !== undefined ? wasVisible : true;
                });
                savedVisibility.clear();
            }
        });

        events.on('splat.name', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.name = splat.name;
            }
        });

        events.on('splat.visibility', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.visible = splat.visible;
            }
        });

        events.on('model.name', (model: GltfModel) => {
            const item = items.get(model);
            if (item) {
                item.name = model.name;
            }
        });

        events.on('model.visibility', (model: GltfModel) => {
            const item = items.get(model);
            if (item) {
                item.visible = model.visible;
            }
        });

        this.on('click', (item: SplatItem) => {
            for (const [element, value] of items) {
                if (item === value) {
                    if (element.type === ElementType.splat) {
                        const splat = element as Splat;
                        if (soloMode && !splat.visible) {
                            splat.visible = true;
                        }
                    }
                    events.fire('selection', element);
                    break;
                }
            }
        });

        this.on('removeClicked', async (item: SplatItem) => {
            let sceneElement: SceneListElement;
            for (const [element, value] of items) {
                if (item === value) {
                    sceneElement = element;
                    break;
                }
            }

            if (!sceneElement) {
                return;
            }

            const isModel = sceneElement.type === ElementType.model;
            const result = await events.invoke('showPopup', {
                type: 'yesno',
                header: isModel ? 'Remove Model' : 'Remove Splat',
                message: `Are you sure you want to remove '${sceneElement.name}' from the scene? This operation can not be undone.`
            });

            if (result?.action === 'yes') {
                sceneElement.destroy();
            }
        });
    }

    protected _onAppendChild(element: PcuiElement): void {
        super._onAppendChild(element);

        if (element instanceof SplatItem) {
            element.on('click', () => {
                this.emit('click', element);
            });

            element.on('removeClicked', () => {
                this.emit('removeClicked', element);
            });
        }
    }

    protected _onRemoveChild(element: PcuiElement): void {
        if (element instanceof SplatItem) {
            element.unbind('click');
            element.unbind('removeClicked');
        }

        super._onRemoveChild(element);
    }
}

export { SplatList, SplatItem };
