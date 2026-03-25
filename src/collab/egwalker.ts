import { CollabAlgorithm, Op } from './algorithm.js';

type Item = { id: string; value: string; visible: boolean };

export class EgWalker implements CollabAlgorithm {
  clientId: string;
  counter: number;
  items: Item[];
  // simple op log and version heads (list of op ids)
  ops: any[];
  heads: string[];

  constructor(clientId: string) {
    this.clientId = clientId;
    this.counter = 1;
    this.items = [];
    this.ops = [];
    this.heads = [];
  }

  makeId() { return `${this.clientId}:${this.counter++}`; }

  applyRemote(op: Op): void {
    if (!op) return;
    if (op.type === 'ins') {
      // dedupe
      if (this.items.find(i => i.id === op.id)) return;
      // insert at provided position if present, otherwise append
      const pos = typeof op.pos === 'number' ? Math.max(0, Math.min(this.items.length, op.pos)) : this.items.length;
      this.items.splice(pos, 0, { id: op.id, value: op.content ?? op.value ?? '', visible: true });
      this.ops.push(op);
      this.heads.push(op.id);
    } else if (op.type === 'del') {
      const it = this.items.find(i => i.id === op.id);
      if (it) it.visible = false;
      this.ops.push(op);
      // deletions don't change heads in this simple model
    }
  }

  localInsert(prevId: any, value: string): Op {
    // create and apply immediately (decentralized behaviour)
    const id = this.makeId();
    const pos = prevId == null ? this.items.length : Math.max(0, (this.items.findIndex(i => i.id === prevId) + 1));
    const op = { type: 'ins', id, pos, content: value, clientId: this.clientId, ts: Date.now() };
    this.applyRemote(op);
    return op;
  }

  createLocalOp(prevId: any, value: string): Op {
    // create op but do not apply locally (for central sequencing)
    const id = this.makeId();
    const pos = prevId == null ? this.items.length : Math.max(0, (this.items.findIndex(i => i.id === prevId) + 1));
    const op = { type: 'ins', id, pos, content: value, clientId: this.clientId, ts: Date.now() };
    return op;
  }

  localDelete(id: any): Op | null {
    const it = this.items.find(i => i.id === id && i.visible);
    if (!it) return null;
    it.visible = false;
    const op = { type: 'del', id, clientId: this.clientId, ts: Date.now() };
    return op;
  }

  getText(): string {
    return this.items.filter(i => i.visible).map(i => i.value).join('');
  }

  serialize() {
    return { clientId: this.clientId, items: this.items.slice(), ops: this.ops.slice(), heads: this.heads.slice() };
  }
}
