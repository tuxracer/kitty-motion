/**
 * Minimal worker surface the client needs — satisfied by worker_threads.Worker
 * and by test fakes.
 */
export interface WorkerLike {
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  on(event: string, listener: (arg?: unknown) => void): unknown;
  terminate(): unknown;
  unref?(): void;
}

export type WorkerFactory = () => WorkerLike | null;

export interface KittyEncodeWorkerClientOptions {
  /** Override worker creation (tests, embedding); defaults to the real worker */
  workerFactory?: WorkerFactory;
  /** Called once if the worker dies or errors; frames may have been lost */
  onFailure?: () => void;
}
