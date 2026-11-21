/**
 * Web Worker that hosts the IFC engine, so reading and editing a large model never freezes
 * the page. The page talks to it through EngineClient (client.ts).
 */
import * as WebIFC from 'web-ifc';
import { IfcEngine } from './ifcEngine.ts';
import type { EditOp, SlicePlane } from './types.ts';

// The worker global is not typed in the DOM lib the app builds against.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: any = self;

let api: WebIFC.IfcAPI | null = null;
const engines = new Map<string, IfcEngine>();

async function ensureApi(wasmBase: string): Promise<WebIFC.IfcAPI> {
  if (api) return api;
  const a = new WebIFC.IfcAPI();
  a.SetWasmPath(wasmBase, true);
  await a.Init(undefined, true);
  api = a;
  return a;
}

function engine(key: string): IfcEngine {
  const e = engines.get(key);
  if (!e) throw new Error('No model is open in the engine.');
  return e;
}

interface Call {
  id: number;
  method: string;
  args: Record<string, unknown>;
}

ctx.onmessage = async (ev: MessageEvent<Call>) => {
  const { id, method, args } = ev.data;
  try {
    let result: unknown;
    const transfer: Transferable[] = [];
    switch (method) {
      case 'open': {
        const a = await ensureApi(String(args.wasmBase));
        const key = String(args.key);
        engines.get(key)?.dispose();
        const e = new IfcEngine(a);
        engines.set(key, e);
        result = e.open(args.bytes as Uint8Array);
        break;
      }
      case 'apply':
        result = engine(String(args.key)).apply(args.op as EditOp);
        break;
      case 'editInfo':
        result = engine(String(args.key)).getEditInfo(Number(args.id));
        break;
      case 'save': {
        const bytes = engine(String(args.key)).save();
        // copy out of wasm memory so it can be handed over without copying again
        const copy = new Uint8Array(bytes);
        transfer.push(copy.buffer);
        result = copy;
        break;
      }
      case 'slice': {
        const storey = args.storey as string | undefined;
        result = engine(String(args.key)).slice(args.plane as SlicePlane, storey ? (r) => r.storey === storey : undefined);
        break;
      }
      case 'dispose':
        engines.get(String(args.key))?.dispose();
        engines.delete(String(args.key));
        result = true;
        break;
      default:
        throw new Error(`Unknown engine call: ${method}`);
    }
    ctx.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
