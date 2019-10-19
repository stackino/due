import { State } from './state';
import { Route } from './route';
import { NoopRoutable, Routable } from './routable';
import { PromiseCompletitionSource, executeProvider, Newable } from '../tools';
import { Container, inject, ContainerTag } from '../ioc';
import { DiagnosticsServiceTag, DiagnosticsService } from '../diagnostics';

export enum TransitionStatus {
	pristine = 100,
	loading = 200,
	executing = 300,
	executed = 400,
	suppressed = 500,
	finished = 600,
	failed = 700,
}

export interface Transition {
	readonly id: string;
	readonly from: Transition | null;
	readonly to: Route;
	readonly toParams: ReadonlyMap<string, string>;
	readonly toData: ReadonlyMap<string | symbol, unknown>;
	readonly status: TransitionStatus;
	readonly finished: Promise<void>;
	readonly entering: readonly State[];
	readonly retained: readonly State[];
	readonly exiting: readonly State[];
	readonly active: readonly State[];
}

/**
 * Represents single lifecycle of a transition.
 */
export class TransitionController implements Transition {
	@inject(ContainerTag)
	private readonly container!: Container;

	@inject(DiagnosticsServiceTag)
	private readonly diagnosticsService!: DiagnosticsService;

	constructor(
		readonly id: string,
		readonly from: Transition | null,
		readonly to: Route,
		readonly toParams: ReadonlyMap<string, string>,
		readonly toData: ReadonlyMap<string | symbol, unknown>
	) {
	}

	private async createEnteringState(route: Route): Promise<State> {
		let Page: Newable<Routable>;
		if (route.declaration.page) {
			const pageOrModule = await executeProvider(route.declaration.page);

			if (typeof pageOrModule === 'object') {
				Page = pageOrModule.default;
			} else {
				Page = pageOrModule;
			}
		} else {
			Page = NoopRoutable;
		}

		const page = this.container.instantiate(Page);

		return new State(route, page, async (setCommitAction) => {
			if (page.enter) {
				const enterCommit = await page.enter(this);

				if (enterCommit) {
					setCommitAction(enterCommit);
				}
			}
		});
	}

	private async createRetainingState(state: State): Promise<State> {
		return new State(state.route, state.page, async (setCommitAction) => {
			if (state.page.retain) {
				const retainCommit = await state.page.retain(this);

				if (retainCommit) {
					setCommitAction(retainCommit);
				}
			}
		});
	}

	private async createExitingState(state: State): Promise<State> {
		return new State(state.route, state.page, async (setCommitAction) => {
			if (state.page.exit) {
				const exitCommit = await state.page.exit(this);

				if (exitCommit) {
					setCommitAction(exitCommit);
				}
			}
		});
	}

	public async execute(): Promise<void> {
		if (this.status === TransitionStatus.suppressed) {
			return;
		}

		if (this.status !== TransitionStatus.pristine) {
			throw new Error('Attempt to execute transition while it\'s not pristine');
		}

		this._status = TransitionStatus.loading;

		const enteringPromises: Promise<State>[] = [];
		const retainedPromises: Promise<State>[] = [];
		const exitingPromises: Promise<State>[] = [];

		let intersection: Route | null = null;
		if (this.from) {
			let retaining = true;

			for (let i = 0; i < this.from.active.length; i++) {
				const current = this.from.active[i];

				if (retaining) {
					if (
						!Route.equals(current.route, this.from.toParams, this.to, this.toParams) &&
						this.to.parents.findIndex(x => Route.equals(current.route, this.from!.toParams, x, this.toParams)) === -1
					) {
						retaining = false;
					} else {
						intersection = current.route;
					}
				}

				if (retaining) {
					const retainingPromise = this.createRetainingState(current);

					retainedPromises.push(retainingPromise);
				} else {
					const exitingPromise = this.createExitingState( current);

					exitingPromises.unshift(exitingPromise);
				}
			}
		}

		let current: Route | null = this.to;
		while (current && current !== intersection) {
			const promise = this.createEnteringState(current);

			enteringPromises.unshift(promise);

			current = current.parent;
		}

		const entering = await Promise.all(enteringPromises);
		const retained = await Promise.all(retainedPromises);
		const exiting = await Promise.all(exitingPromises);

		if (this.status as TransitionStatus === TransitionStatus.suppressed) {
			return;
		}

		this._entering = entering;
		this._retained = retained;
		this._exiting = exiting;
		this._status = TransitionStatus.executing;

		for (const state of retained) {
			await state.run();

			if (this.status as TransitionStatus === TransitionStatus.suppressed) {
				return;
			}
		}
		for (const state of entering) {
			await state.run();

			if (this.status as TransitionStatus === TransitionStatus.suppressed) {
				return;
			}
		}
		for (const state of exiting) {
			await state.run();

			if (this.status as TransitionStatus === TransitionStatus.suppressed) {
				return;
			}
		}

		this._status = TransitionStatus.executed;
	}

	public suppress(): void {
		if (this.status === TransitionStatus.finished) {
			throw new Error('Attempt to suppress finished transition');
		}
		this._status = TransitionStatus.suppressed;

		this._finished.tryResolve();
	}

	public fail(error: unknown): void {
		if (this.status === TransitionStatus.finished) {
			throw new Error('Attempt to fail finished transition');
		}
		this._status = TransitionStatus.failed;

		this.diagnosticsService.error(error);

		this._finished.tryResolve();
	}

	public finish(): void {
		if (this.status !== TransitionStatus.executed) {
			throw new Error('Attempt to finish transition while it\'s not executed');
		}

		for (const state of this.exiting) {
			state.commit();
		}
		for (const state of this.retained) {
			state.commit();
		}
		for (const state of this.entering) {
			state.commit();
		}
		this._status = TransitionStatus.finished;

		this._finished.tryResolve();
	}

	private _finished: PromiseCompletitionSource<void> = new PromiseCompletitionSource();
	public get finished(): Promise<void> {
		return this._finished.promise;
	}

	private _status: TransitionStatus = TransitionStatus.pristine;
	public get status(): TransitionStatus {
		return this._status;
	}

	private _entering: readonly State[] | null = null;
	public get entering(): readonly State[] {
		if (!this._entering) {
			throw new Error('Attempt to obtain entering states while transition is loading.');
		}

		return this._entering;
	}

	private _retained: readonly State[] | null = null;
	public get retained(): readonly State[] {
		if (!this._retained) {
			throw new Error('Attempt to obtain retained states while transition is loading.');
		}

		return this._retained;
	}

	private _exiting: readonly State[] | null = null;
	public get exiting(): readonly State[] {
		if (!this._exiting) {
			throw new Error('Attempt to obtain exiting states while transition is loading.');
		}

		return this._exiting;
	}

	private _active: readonly State[] | null = null;
	public get active(): readonly State[] {
		if (this._active) {
			return this._active;
		}

		if (!this._entering || !this._retained || !this._exiting) {
			throw new Error('Attempt to obtain active states while transition is loading.');
		}

		const active: State[] = [];
		for (const s of this.retained) {
			active.push(s);
		}
		for (const s of this.entering) {
			active.push(s);
		}
		this._active = active

		return active;
	}
}
