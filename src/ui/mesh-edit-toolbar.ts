import { Button, Container, Label } from '@playcanvas/pcui';

import { ElementType } from '../element';
import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

type MeshEditMode = 'vertex' | 'edge' | 'face';

class MeshEditToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            id: 'mesh-edit-toolbar',
            class: 'mesh-edit-toolbar',
            hidden: true,
            ...args
        };

        super(args);

        ['pointerdown', 'pointerup', 'click'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const title = new Label({ class: 'mesh-edit-title' });
        i18n.bindText(title, 'mesh-edit.title');

        const createModeButton = (mode: MeshEditMode) => {
            const button = new Button({
                id: `mesh-edit-${mode}`,
                class: 'mesh-edit-mode'
            });
            i18n.bindText(button, `mesh-edit.${mode}`);
            button.on('click', () => events.fire('meshEdit.setMode', mode));
            tooltips.register(button, () => i18n.t(`mesh-edit.${mode}`), 'top');
            return button;
        };

        const vertex = createModeButton('vertex');
        const edge = createModeButton('edge');
        const face = createModeButton('face');

        let selectedCount = 0;
        const status = new Label({ class: 'mesh-edit-status' });
        i18n.bindText(status, () => i18n.t('mesh-edit.selected', { count: selectedCount }));

        const hint = new Label({ class: 'mesh-edit-hint' });
        i18n.bindText(hint, 'mesh-edit.hint');

        this.append(title);
        this.append(vertex);
        this.append(edge);
        this.append(face);
        this.append(status);
        this.append(hint);

        events.on('meshEdit.mode', (mode: MeshEditMode) => {
            vertex.class[mode === 'vertex' ? 'add' : 'remove']('active');
            edge.class[mode === 'edge' ? 'add' : 'remove']('active');
            face.class[mode === 'face' ? 'add' : 'remove']('active');
        });

        events.on('meshEdit.selectionChanged', (details: { count: number }) => {
            selectedCount = details.count;
            status.text = i18n.t('mesh-edit.selected', { count: selectedCount });
        });

        events.on('selection.changed', (selection: { type?: ElementType }) => {
            const enabled = selection?.type === ElementType.model;
            vertex.enabled = edge.enabled = face.enabled = enabled;
        });

        events.on('tool.activated', (toolName: string) => {
            this.hidden = toolName !== 'meshEdit';
        });
    }
}

export { MeshEditToolbar };
