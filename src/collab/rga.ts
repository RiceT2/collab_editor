import { CollabAlgorithm, Op } from './algorithm.js';

type NodeRec = { id: string; value: string; visible: boolean; prevId: string | null };

export class RGA implements CollabAlgorithm {
  clientId: string;
  counter: number;
  nodes: NodeRec[];
  pendingDeletes: Set<string>;

  constructor(clientId: string) {
    this.clientId = clientId;
    this.counter = 1;
    this.nodes = [];
    this.pendingDeletes = new Set();
  }

  makeId() {
    return `${this.clientId}:${this.counter++}`;
  }

  private findIndexAfter(prevId: string | null) {
    const prevIndex = prevId === null ? -1 : this.nodes.findIndex(n => n.id === prevId);
    let insertPos = prevIndex + 1;
    while (insertPos < this.nodes.length && this.nodes[insertPos].prevId === prevId) {
      // deterministic order among siblings by id
      if (this.nodes[insertPos].id < (prevId === null ? '' : '')) insertPos++;
      else break;
    }
    return insertPos;
  }

  applyRemote(op: Op): void {
    if (op && op.type === 'insert') {
      const exists = this.nodes.find(n => n.id === op.id);
      if (exists) return;
      const prevIndex = op.prevId === null ? -1 : this.nodes.findIndex(n => n.id === op.prevId);
      let insertPos = prevIndex + 1;
      while (insertPos < this.nodes.length && this.nodes[insertPos].prevId === op.prevId) {
        if (this.nodes[insertPos].id < op.id) insertPos++;
        else break;
      }
      const visible = !this.pendingDeletes.has(op.id);
      this.nodes.splice(insertPos, 0, { id: op.id, value: op.value, visible, prevId: op.prevId });
    } else if (op && op.type === 'delete') {
      const node = this.nodes.find(n => n.id === op.id);
      if (node) node.visible = false;
      else this.pendingDeletes.add(op.id);
    }
  }

  localInsert(prevId: string | null, value: string): Op {
    const id = this.makeId();
    const op = { type: 'insert', id, value, prevId, clientId: this.clientId, ts: Date.now() };
    this.applyRemote(op);
    return op;
  }

  createLocalOp(prevId: string | null, value: string): Op {
    const id = this.makeId();
    const op = { type: 'insert', id, value, prevId, clientId: this.clientId, ts: Date.now() };
    return op;
  }

  localDelete(id: string): Op | null {
    const node = this.nodes.find(n => n.id === id && n.visible);
    if (!node) return null;
    node.visible = false;
    const op = { type: 'delete', id, clientId: this.clientId, ts: Date.now() };
    return op;
  }

  getText(): string {
    return this.nodes.filter(n => n.visible).map(n => n.value).join('');
  }

  serialize() {
    return { clientId: this.clientId, nodes: this.nodes };
  }
}
