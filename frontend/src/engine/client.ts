import type { EditInfo, EditOp, EditResult, ModelTable, SlicePlane, SliceResult } from './types.ts';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Promise-based handle on the engine worker. One worker serves the whole page. */
export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private wasmBase = `${window.location.origin}${import.meta.env.BASE_URL}`;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error || 'The model engine failed.'));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'The model engine stopped.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private call<T>(method: string, args: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args }, transfer);
    });
  }

  /** Reads and measures a model. The bytes are copied, so the caller keeps its own. */
  open(key: string, bytes: Uint8Array): Promise<ModelTable> {
    const copy = bytes.slice();
    return this.call('open', { key, bytes: copy, wasmBase: this.wasmBase }, [copy.buffer]);
  }

  apply(key: string, op: EditOp): Promise<EditResult> {
    return this.call('apply', { key, op });
  }

  editInfo(key: string, id: number): Promise<EditInfo | null> {
    return this.call('editInfo', { key, id });
  }

  save(key: string): Promise<Uint8Array> {
    return this.call('save', { key });
  }

  slice(key: string, plane: SlicePlane, storey?: string): Promise<SliceResult> {
    return this.call('slice', { key, plane, storey });
  }

  dispose(key: string): Promise<boolean> {
    return this.call('dispose', { key });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
