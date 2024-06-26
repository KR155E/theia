// *****************************************************************************
// Copyright (C) 2021 SAP SE or an SAP affiliate company and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { CustomEditor, DeployedPlugin } from '../../../common';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { CustomEditorOpener } from './custom-editor-opener';
import { Emitter } from '@theia/core';
import { ApplicationShell, DefaultOpenerService, OpenWithService, WidgetManager, WidgetOpenerOptions } from '@theia/core/lib/browser';
import { CustomEditorWidget } from './custom-editor-widget';

@injectable()
export class PluginCustomEditorRegistry {
    private readonly editors = new Map<string, CustomEditor>();
    private readonly pendingEditors = new Set<CustomEditorWidget>();
    private readonly resolvers = new Map<string, (widget: CustomEditorWidget, options?: WidgetOpenerOptions) => void>();

    private readonly onWillOpenCustomEditorEmitter = new Emitter<string>();
    readonly onWillOpenCustomEditor = this.onWillOpenCustomEditorEmitter.event;

    @inject(DefaultOpenerService)
    protected readonly defaultOpenerService: DefaultOpenerService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(OpenWithService)
    protected readonly openWithService: OpenWithService;

    @postConstruct()
    protected init(): void {
        this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
            if (factoryId === CustomEditorWidget.FACTORY_ID && widget instanceof CustomEditorWidget) {
                const restoreState = widget.restoreState.bind(widget);

                widget.restoreState = state => {
                    if (state.viewType && state.strResource) {
                        restoreState(state);
                        this.resolveWidget(widget);
                    } else {
                        widget.dispose();
                    }
                };
            }
        });
    }

    registerCustomEditor(editor: CustomEditor, plugin: DeployedPlugin): Disposable {
        if (this.editors.has(editor.viewType)) {
            console.warn('editor with such id already registered: ', JSON.stringify(editor));
            return Disposable.NULL;
        }
        this.editors.set(editor.viewType, editor);

        const toDispose = new DisposableCollection();
        toDispose.push(Disposable.create(() => this.editors.delete(editor.viewType)));

        const editorOpenHandler = new CustomEditorOpener(
            editor,
            this.shell,
            this.widgetManager
        );
        toDispose.push(this.defaultOpenerService.addHandler(editorOpenHandler));
        toDispose.push(
            this.openWithService.registerHandler({
                id: editor.viewType,
                label: editorOpenHandler.label,
                providerName: plugin.metadata.model.displayName,
                canHandle: uri => editorOpenHandler.canHandle(uri),
                open: uri => editorOpenHandler.open(uri)
            })
        );
        toDispose.push(
            editorOpenHandler.onDidOpenCustomEditor(event => this.resolveWidget(event[0], event[1]))
        );
        return toDispose;
    }

    resolveWidget = (widget: CustomEditorWidget, options?: WidgetOpenerOptions) => {
        const resolver = this.resolvers.get(widget.viewType);
        if (resolver) {
            resolver(widget, options);
        } else {
            this.pendingEditors.add(widget);
            this.onWillOpenCustomEditorEmitter.fire(widget.viewType);
        }
    };

    registerResolver(viewType: string, resolver: (widget: CustomEditorWidget, options?: WidgetOpenerOptions) => void): Disposable {
        if (this.resolvers.has(viewType)) {
            throw new Error(`Resolver for ${viewType} already registered`);
        }

        for (const editorWidget of this.pendingEditors) {
            if (editorWidget.viewType === viewType) {
                resolver(editorWidget);
                this.pendingEditors.delete(editorWidget);
            }
        }

        this.resolvers.set(viewType, resolver);
        return Disposable.create(() => this.resolvers.delete(viewType));
    }
}
