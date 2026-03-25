import { CollabAlgorithm, Op } from './algorithm.js';

// Improved OT example with simple transform logic to handle concurrent
// insert/delete operations. This is still a simplified educational OT
// implementation (assumes char-granularity operations) but provides basic
// convergence behavior in our simulated benchmark.

type BaseClock = Record<string, number>;
type OTInsert = { type: 'insert'; pos: number; value: string; clientId: string; ts: number; id: string; base?: BaseClock; seq?: number };
type OTDelete = { type: 'delete'; pos: number; len: number; clientId: string; ts: number; id: string; base?: BaseClock; seq?: number };
type OTOp = OTInsert | OTDelete;

export class OT implements CollabAlgorithm {
  clientId: string;
  doc: string;
  counter: number;
  // history of local ops applied on this site (including own and transformed remote)
  history: OTOp[];
  // local per-client sequence counter
  seqCounter: number;
  // seen clock: counts of ops seen per client
  clock: Record<string, number>;

  constructor(clientId: string) {
    this.clientId = clientId;
    this.doc = '';
    this.counter = 1;
    this.history = [];
    this.seqCounter = 0;
    this.clock = {};
  }

  makeId() {
    return `${this.clientId}:${this.counter++}`;
  }

  // transform incoming op against a single local op
  private transform(incoming: OTOp, local: OTOp): OTOp {
    const op = { ...incoming } as OTOp;
    if (op.type === 'insert' && local.type === 'insert') {
      if (local.pos < op.pos || (local.pos === op.pos && local.clientId < op.clientId)) {
        op.pos += local.value.length;
      }
    } else if (op.type === 'insert' && local.type === 'delete') {
      if (local.pos < op.pos) {
        const dec = Math.min(local.len, op.pos - local.pos);
        op.pos -= dec;
      }
    } else if (op.type === 'delete' && local.type === 'insert') {
      if (local.pos <= op.pos) {
        op.pos += local.value.length;
      }
    } else if (op.type === 'delete' && local.type === 'delete') {
      if (local.pos < op.pos) {
        const dec = Math.min(local.len, op.pos - local.pos);
        op.pos -= dec;
      } else if (local.pos === op.pos) {
        // if both delete same position, let both proceed (idempotent)
      }
    }
    return op;
  }

  applyRemote(opRaw: Op): void {
    if (!opRaw) return;
    const op = { ...(opRaw as any) } as OTOp;

    // Transform incoming op against local history entries that the sender
    // didn't know about. The sender provides a `base` clock mapping clientId
    // -> last-seen-seq; any local history op whose (clientId, seq) is greater
    // than base[clientId] should be used to transform the incoming op.
    let transformed = { ...op } as OTOp;
    const base: BaseClock = (op as any).base ?? {};
    for (const local of this.history) {
      const lseq = (local as any).seq ?? 0;
      const lclient = local.clientId;
      const baseSeen = base[lclient] ?? 0;
      if (local.id === transformed.id) continue;
      if (lseq > baseSeen) {
        transformed = this.transform(transformed, local);
      }
    }

    // apply transformed op to document
    if (transformed.type === 'insert') {
      const p = Math.max(0, Math.min(this.doc.length, transformed.pos));
      this.doc = this.doc.slice(0, p) + transformed.value + this.doc.slice(p);
    } else if (transformed.type === 'delete') {
      const p = Math.max(0, Math.min(this.doc.length, transformed.pos));
      this.doc = this.doc.slice(0, p) + this.doc.slice(p + transformed.len);
    }

    // record into history (as applied here)
    this.history.push(transformed);
    // update seen clock for incoming op's client
    if ((transformed as any).seq) {
      const s = (transformed as any).seq as number;
      this.clock[transformed.clientId] = Math.max(this.clock[transformed.clientId] || 0, s);
    }
  }

  // localInsert: pos numeric (null => append)
  localInsert(prevId: any, value: string): Op {
    const pos = prevId === null ? this.doc.length : Number(prevId) || this.doc.length;
    const seq = ++this.seqCounter;
    const op: OTInsert = { type: 'insert', pos, value, clientId: this.clientId, ts: Date.now(), id: this.makeId(), base: { ...this.clock }, seq };
    // apply locally
    const p = Math.max(0, Math.min(this.doc.length, op.pos));
    this.doc = this.doc.slice(0, p) + op.value + this.doc.slice(p);
    this.history.push(op);
    return op as Op;
  }

  localDelete(id: any): Op | null {
    const pos = Number(id);
    if (isNaN(pos) || pos < 0 || pos >= this.doc.length) return null;
    const seq = ++this.seqCounter;
    const op: OTDelete = { type: 'delete', pos, len: 1, clientId: this.clientId, ts: Date.now(), id: this.makeId(), base: { ...this.clock }, seq };
    // apply locally
    const p = Math.max(0, Math.min(this.doc.length, op.pos));
    this.doc = this.doc.slice(0, p) + this.doc.slice(p + op.len);
    this.history.push(op);
    return op as Op;
  }

  createLocalOp(prevId: any, value: string): Op {
    // for OT, prevId treated as pos
    const pos = prevId === null ? this.doc.length : Number(prevId) || this.doc.length;
    const seq = ++this.seqCounter;
    const op: OTInsert = { type: 'insert', pos, value, clientId: this.clientId, ts: Date.now(), id: this.makeId(), base: { ...this.clock }, seq };
    return op as Op;
  }

  getText(): string {
    return this.doc;
  }

  serialize() {
    return { clientId: this.clientId, doc: this.doc, historyLen: this.history.length };
  }
}
