/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as resources from 'vs/base/common/resources';
import * as dom from 'vs/base/browser/dom';
import * as errors from 'vs/base/common/errors';
import { IAction } from 'vs/base/common/actions';
import { IViewletViewOptions, ViewsViewletPanel } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IDebugService, IBreakpoint, CONTEXT_BREAKPOINTS_FOCUSED, State, DEBUG_SCHEME, IFunctionBreakpoint, IExceptionBreakpoint, IEnablement } from 'vs/workbench/parts/debug/common/debug';
import { ExceptionBreakpoint, FunctionBreakpoint, Breakpoint } from 'vs/workbench/parts/debug/common/debugModel';
import { AddFunctionBreakpointAction, ToggleBreakpointsActivatedAction, RemoveAllBreakpointsAction, RemoveBreakpointAction, EnableAllBreakpointsAction, DisableAllBreakpointsAction, ReapplyBreakpointsAction } from 'vs/workbench/parts/debug/browser/debugActions';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IListService } from 'vs/platform/list/browser/listService';
import { attachListStyler } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { Constants } from 'vs/editor/common/core/uint';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { getPathLabel } from 'vs/base/common/labels';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { basename } from 'vs/base/common/paths';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { TPromise } from 'vs/base/common/winjs.base';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { List } from 'vs/base/browser/ui/list/listWidget';
import { IDelegate, IRenderer, IListContextMenuEvent } from 'vs/base/browser/ui/list/list';
import { IEditorService } from 'vs/platform/editor/common/editor';

const $ = dom.$;

export class BreakpointsView extends ViewsViewletPanel {

	private static readonly MAX_VISIBLE_FILES = 9;
	private static readonly MEMENTO = 'breakopintsview.memento';
	private breakpointsFocusedContext: IContextKey<boolean>;
	private settings: any;
	private list: List<IEnablement>;
	private needsRefresh: boolean;

	constructor(
		options: IViewletViewOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IDebugService private debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService private listService: IListService,
		@IThemeService private themeService: IThemeService,
		@IEditorService private editorService: IEditorService
	) {
		super(options, keybindingService, contextMenuService);

		this.minimumBodySize = this.maximumBodySize = this.getExpandedBodySize();
		this.settings = options.viewletSettings;
		this.breakpointsFocusedContext = CONTEXT_BREAKPOINTS_FOCUSED.bindTo(contextKeyService);
		this.disposables.push(this.debugService.getModel().onDidChangeBreakpoints(() => this.onBreakpointsChange()));
	}

	public renderBody(container: HTMLElement): void {
		dom.addClass(container, 'debug-breakpoints');
		const delegate = new BreakpointsDelegate();

		this.list = new List<IEnablement>(container, delegate, [
			this.instantiationService.createInstance(BreakpointsRenderer),
			new ExceptionBreakpointsRenderer(this.debugService),
			new FunctionBreakpointsRenderer(this.debugService)
		], {
				identityProvider: element => element.getId()
			});

		this.disposables.push(attachListStyler(this.list, this.themeService));
		this.disposables.push(this.listService.register(this.list, [this.breakpointsFocusedContext]));
		this.list.onContextMenu(this.onListContextMenu, this, this.disposables);
		this.list.onSelectionChange(event => {
			// TODO@Isidor need to check if double click
			const element = event.elements.length ? event.elements[0] : undefined;
			if (element instanceof FunctionBreakpoint /* && event.detail === 2 */) {
				this.debugService.getViewModel().setSelectedFunctionBreakpoint(element);
			}
			if (element instanceof Breakpoint) {
				openBreakpointSource(element, event, true, this.debugService, this.editorService);
			}
		});

		this.list.splice(0, 0, this.elements);

		// TODO@Isidor
		// this.disposables.push(this.debugService.getViewModel().onDidSelectFunctionBreakpoint(fbp => {
		// 	if (!fbp || !(fbp instanceof FunctionBreakpoint)) {
		// 		return;
		// 	}

		// 	this.tree.refresh(fbp, false).then(() => {
		// 		this.list.setHighlight(fbp);
		// 		once(this.tree.onDidChangeHighlight)((e: IHighlightEvent) => {
		// 			if (!e.highlight) {
		// 				this.debugService.getViewModel().setSelectedFunctionBreakpoint(null);
		// 			}
		// 		});
		// 	}).done(null, errors.onUnexpectedError);
		// }));
	}

	protected layoutBody(size: number): void {
		this.list.layout(size);
	}

	private onListContextMenu(e: IListContextMenuEvent<IEnablement>): void {
		const actions: IAction[] = [];
		actions.push(new RemoveBreakpointAction(RemoveBreakpointAction.ID, RemoveBreakpointAction.LABEL, this.debugService, this.keybindingService));
		if (this.debugService.getModel().getBreakpoints().length + this.debugService.getModel().getFunctionBreakpoints().length > 1) {
			actions.push(new RemoveAllBreakpointsAction(RemoveAllBreakpointsAction.ID, RemoveAllBreakpointsAction.LABEL, this.debugService, this.keybindingService));
			actions.push(new Separator());

			actions.push(new EnableAllBreakpointsAction(EnableAllBreakpointsAction.ID, EnableAllBreakpointsAction.LABEL, this.debugService, this.keybindingService));
			actions.push(new DisableAllBreakpointsAction(DisableAllBreakpointsAction.ID, DisableAllBreakpointsAction.LABEL, this.debugService, this.keybindingService));
		}

		actions.push(new Separator());
		actions.push(new ReapplyBreakpointsAction(ReapplyBreakpointsAction.ID, ReapplyBreakpointsAction.LABEL, this.debugService, this.keybindingService));

		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => TPromise.as(actions),
			getActionsContext: () => e.element
		});
	}

	public getActions(): IAction[] {
		return [
			new AddFunctionBreakpointAction(AddFunctionBreakpointAction.ID, AddFunctionBreakpointAction.LABEL, this.debugService, this.keybindingService),
			new ToggleBreakpointsActivatedAction(ToggleBreakpointsActivatedAction.ID, ToggleBreakpointsActivatedAction.ACTIVATE_LABEL, this.debugService, this.keybindingService),
			new RemoveAllBreakpointsAction(RemoveAllBreakpointsAction.ID, RemoveAllBreakpointsAction.LABEL, this.debugService, this.keybindingService)
		];
	}

	public setExpanded(expanded: boolean): void {
		super.setExpanded(expanded);
		if (expanded && this.needsRefresh) {
			this.onBreakpointsChange();
		}
	}

	public setVisible(visible: boolean): TPromise<void> {
		return super.setVisible(visible).then(() => {
			if (visible && this.needsRefresh) {
				this.onBreakpointsChange();
			}
		});
	}

	private onBreakpointsChange(): void {
		if (this.isExpanded() && this.isVisible()) {
			this.minimumBodySize = this.getExpandedBodySize();
			if (this.maximumBodySize < Number.POSITIVE_INFINITY) {
				this.maximumBodySize = this.minimumBodySize;
			}
			if (this.list) {
				this.list.splice(0, this.list.length, this.elements);
				this.needsRefresh = false;
			}
		} else {
			this.needsRefresh = true;
		}
	}

	private get elements(): IEnablement[] {
		const model = this.debugService.getModel();
		const elements = (<IEnablement[]>model.getExceptionBreakpoints()).concat(model.getFunctionBreakpoints()).concat(model.getBreakpoints());

		return elements;
	}

	private getExpandedBodySize(): number {
		const model = this.debugService.getModel();
		const length = model.getBreakpoints().length + model.getExceptionBreakpoints().length + model.getFunctionBreakpoints().length;
		return Math.min(BreakpointsView.MAX_VISIBLE_FILES, length) * 22;
	}

	public shutdown(): void {
		this.settings[BreakpointsView.MEMENTO] = !this.isExpanded();
	}
}

class BreakpointsDelegate implements IDelegate<IEnablement> {

	getHeight(element: IEnablement): number {
		return 22;
	}

	getTemplateId(element: IEnablement): string {
		if (element instanceof Breakpoint) {
			return BreakpointsRenderer.ID;
		}
		if (element instanceof FunctionBreakpoint) {
			return FunctionBreakpointsRenderer.ID;
		}
		if (element instanceof ExceptionBreakpoint) {
			return ExceptionBreakpointsRenderer.ID;
		}

		return undefined;
	}
}

interface IBaseBreakpointTemplateData {
	breakpoint: HTMLElement;
	name: HTMLElement;
	checkbox: HTMLInputElement;
	context: IEnablement;
	toDispose: IDisposable[];
}

interface IBreakpointTemplateData extends IBaseBreakpointTemplateData {
	lineNumber: HTMLElement;
	filePath: HTMLElement;
}

class BreakpointsRenderer implements IRenderer<IBreakpoint, IBreakpointTemplateData> {

	constructor(
		@IDebugService private debugService: IDebugService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IEnvironmentService private environmentService: IEnvironmentService
	) {
		// noop
	}

	static ID = 'breakpoints';

	get templateId() {
		return BreakpointsRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IBreakpointTemplateData {
		const data: IBreakpointTemplateData = Object.create(null);
		data.breakpoint = dom.append(container, $('.breakpoint'));

		data.checkbox = <HTMLInputElement>$('input');
		data.checkbox.type = 'checkbox';
		data.toDispose = [];
		data.toDispose.push(dom.addStandardDisposableListener(data.checkbox, 'change', (e) => {
			this.debugService.enableOrDisableBreakpoints(!data.context.enabled, data.context);
		}));

		dom.append(data.breakpoint, data.checkbox);

		data.name = dom.append(data.breakpoint, $('span.name'));

		data.filePath = dom.append(data.breakpoint, $('span.file-path'));
		const lineNumberContainer = dom.append(data.breakpoint, $('.line-number-container'));
		data.lineNumber = dom.append(lineNumberContainer, $('span.line-number'));

		return data;
	}

	renderElement(breakpoint: IBreakpoint, index: number, data: IBreakpointTemplateData): void {
		data.context = breakpoint;
		dom.toggleClass(data.breakpoint, 'disabled', !this.debugService.getModel().areBreakpointsActivated());

		data.name.textContent = basename(getPathLabel(breakpoint.uri, this.contextService));
		data.lineNumber.textContent = breakpoint.lineNumber.toString();
		if (breakpoint.column) {
			data.lineNumber.textContent += `:${breakpoint.column}`;
		}
		data.filePath.textContent = getPathLabel(resources.dirname(breakpoint.uri), this.contextService, this.environmentService);
		data.checkbox.checked = breakpoint.enabled;

		const debugActive = this.debugService.state === State.Running || this.debugService.state === State.Stopped;
		if (debugActive && !breakpoint.verified) {
			dom.addClass(data.breakpoint, 'disabled');
			if (breakpoint.message) {
				data.breakpoint.title = breakpoint.message;
			}
		} else if (breakpoint.condition || breakpoint.hitCondition) {
			data.breakpoint.title = breakpoint.condition ? breakpoint.condition : breakpoint.hitCondition;
		}
	}

	disposeTemplate(templateData: IBreakpointTemplateData): void {
		dispose(templateData.toDispose);
	}
}

class ExceptionBreakpointsRenderer implements IRenderer<IExceptionBreakpoint, IBaseBreakpointTemplateData> {

	constructor(
		private debugService: IDebugService
	) {
		// noop
	}

	static ID = 'exceptionbreakpoints';

	get templateId() {
		return ExceptionBreakpointsRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IBaseBreakpointTemplateData {
		const data: IBreakpointTemplateData = Object.create(null);
		data.breakpoint = dom.append(container, $('.breakpoint'));

		data.checkbox = <HTMLInputElement>$('input');
		data.checkbox.type = 'checkbox';
		data.toDispose = [];
		data.toDispose.push(dom.addStandardDisposableListener(data.checkbox, 'change', (e) => {
			this.debugService.enableOrDisableBreakpoints(!data.context.enabled, data.context);
		}));

		dom.append(data.breakpoint, data.checkbox);

		data.name = dom.append(data.breakpoint, $('span.name'));
		dom.addClass(data.breakpoint, 'exception');

		return data;
	}

	renderElement(exceptionBreakpoint: IExceptionBreakpoint, index: number, data: IBaseBreakpointTemplateData): void {
		data.context = exceptionBreakpoint;
		data.name.textContent = exceptionBreakpoint.label || `${exceptionBreakpoint.filter} exceptions`;
		data.breakpoint.title = data.name.textContent;
		data.checkbox.checked = exceptionBreakpoint.enabled;
	}

	disposeTemplate(templateData: IBaseBreakpointTemplateData): void {
		dispose(templateData.toDispose);
	}
}

class FunctionBreakpointsRenderer implements IRenderer<IFunctionBreakpoint, IBaseBreakpointTemplateData> {

	constructor(
		private debugService: IDebugService
	) {
		// noop
	}

	static ID = 'functionbreakpoints';

	get templateId() {
		return FunctionBreakpointsRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IBaseBreakpointTemplateData {
		const data: IBreakpointTemplateData = Object.create(null);
		data.breakpoint = dom.append(container, $('.breakpoint'));

		data.checkbox = <HTMLInputElement>$('input');
		data.checkbox.type = 'checkbox';
		data.toDispose = [];
		data.toDispose.push(dom.addStandardDisposableListener(data.checkbox, 'change', (e) => {
			this.debugService.enableOrDisableBreakpoints(!data.context.enabled, data.context);
		}));

		dom.append(data.breakpoint, data.checkbox);

		data.name = dom.append(data.breakpoint, $('span.name'));

		return data;
	}

	renderElement(functionBreakpoint: IFunctionBreakpoint, index: number, data: IBaseBreakpointTemplateData): void {
		data.context = functionBreakpoint;
		const selected = this.debugService.getViewModel().getSelectedFunctionBreakpoint();
		if (!functionBreakpoint.name || (selected && selected.getId() === functionBreakpoint.getId())) {
			data.name.textContent = '';
			// TODO@Isidor
			// renderRenameBox(this.debugService, this.contextViewService, this.themeService, tree, functionBreakpoint, data.breakpoint, {
			// 	initialValue: functionBreakpoint.name,
			// 	placeholder: nls.localize('functionBreakpointPlaceholder', "Function to break on"),
			// 	ariaLabel: nls.localize('functionBreakPointInputAriaLabel', "Type function breakpoint")
			// });
		} else {
			data.name.textContent = functionBreakpoint.name;
			data.checkbox.checked = functionBreakpoint.enabled;
			data.breakpoint.title = functionBreakpoint.name;

			// Mark function breakpoints as disabled if deactivated or if debug type does not support them #9099
			const process = this.debugService.getViewModel().focusedProcess;
			dom.toggleClass(data.breakpoint, 'disalbed', (process && !process.session.capabilities.supportsFunctionBreakpoints) || !this.debugService.getModel().areBreakpointsActivated());
			if (process && !process.session.capabilities.supportsFunctionBreakpoints) {
				data.breakpoint.title = nls.localize('functionBreakpointsNotSupported', "Function breakpoints are not supported by this debug type");
			}
		}
	}

	disposeTemplate(templateData: IBaseBreakpointTemplateData): void {
		dispose(templateData.toDispose);
	}
}

function openBreakpointSource(breakpoint: Breakpoint, event: any, preserveFocus: boolean, debugService: IDebugService, editorService: IEditorService): void {
	if (breakpoint.uri.scheme === DEBUG_SCHEME && debugService.state === State.Inactive) {
		return;
	}

	const sideBySide = (event && (event.ctrlKey || event.metaKey));
	const selection = breakpoint.endLineNumber ? {
		startLineNumber: breakpoint.lineNumber,
		endLineNumber: breakpoint.endLineNumber,
		startColumn: breakpoint.column,
		endColumn: breakpoint.endColumn
	} : {
			startLineNumber: breakpoint.lineNumber,
			startColumn: breakpoint.column || 1,
			endLineNumber: breakpoint.lineNumber,
			endColumn: breakpoint.column || Constants.MAX_SAFE_SMALL_INTEGER
		};

	editorService.openEditor({
		resource: breakpoint.uri,
		options: {
			preserveFocus,
			selection,
			revealIfVisible: true,
			revealInCenterIfOutsideViewport: true,
			pinned: !preserveFocus
		}
	}, sideBySide).done(undefined, errors.onUnexpectedError);
}
