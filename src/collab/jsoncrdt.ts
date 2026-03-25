import { CollabAlgorithm, Op } from './algorithm.js';

// A tiny state-based JSON CRDT keyed by property names with last-write-wins
// semantics. Not a full JSON CRDT, but useful as a plug-in example.

type Entry = { value: any; ts: number; clientId: string };

export class JSONCRDT implements CollabAlgorithm {
  clientId: string;
  store: Map<string, Entry>;

  constructor(clientId: string) {
    this.clientId = clientId;
    this.store = new Map();
  }

  applyRemote(op: Op): void {
    if (!op) return;
    if (op.type === 'set') {
      const prev = this.store.get(op.key);
      if (!prev || op.ts > prev.ts || (op.ts === prev.ts && op.clientId > prev.clientId)) {
        this.store.set(op.key, { value: op.value, ts: op.ts, clientId: op.clientId });
      }
    } else if (op.type === 'delete') {
      const prev = this.store.get(op.key);
      if (!prev || op.ts > prev.ts || (op.ts === prev.ts && op.clientId > prev.clientId)) {
        this.store.delete(op.key);
      }
    }
  }

  // prevId: for demo we treat prevId as the key name to set
  localInsert(prevId: any, value: string): Op {
    const key = (prevId === null) ? `k${Date.now()}_${Math.random().toString(36).slice(2,8)}` : String(prevId);
    const op = { type: 'set', key, value, clientId: this.clientId, ts: Date.now() };
    this.applyRemote(op);
    return op as Op;
  }

  createLocalOp(prevId: any, value: string): Op {
    const key = (prevId === null) ? `k${Date.now()}_${Math.random().toString(36).slice(2,8)}` : String(prevId);
    const op = { type: 'set', key, value, clientId: this.clientId, ts: Date.now() };
    return op as Op;
  }

  localDelete(id: any): Op | null {
    const key = String(id);
    const op = { type: 'delete', key, clientId: this.clientId, ts: Date.now() };
    this.applyRemote(op);
    return op as Op;
  }

  getText(): string {
    // deterministic string representation sorted by key
    const obj: any = {};
    Array.from(this.store.keys()).sort().forEach(k => { obj[k] = this.store.get(k)!.value; });
    return JSON.stringify(obj);
  }

  serialize() {
    return { clientId: this.clientId, entries: Array.from(this.store.entries()) };
  }
}
