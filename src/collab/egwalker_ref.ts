import { CollabAlgorithm, Op } from './algorithm.js';
import * as egw from './egwalker_ref_impl.js';

export class EgWalkerRef implements CollabAlgorithm {
  clientId: string;
  oplog: egw.ListOpLog<string>;

  constructor(clientId: string) {
    this.clientId = clientId;
    this.oplog = egw.createOpLog<string>();
  }

  applyRemote(op: Op): void {
    if (!op) return;
    // expected op format: { id: [agent, seq], parents: RawVersion[], type: 'ins'|'del', pos, content }
    try {
      if (op.type === 'ins') {
        egw.pushOp(this.oplog, op.id, op.parents, 'ins', op.pos, op.content ?? op.value);
      } else if (op.type === 'del') {
        egw.pushOp(this.oplog, op.id, op.parents, 'del', op.pos);
      }
    } catch (e) {
      // ignore duplicates / errors
    }
  }

  localInsert(prevId: any, value: string): Op {
    // naive: append at end
    egw.localInsert(this.oplog, this.clientId, this.oplog.ops.length, value);
    const seq = egw.causalGraph.nextSeqForAgent(this.oplog.cg, this.clientId) - 1;
    const id = [this.clientId, seq] as any;
    const parents = egw.getLatestVersion(this.oplog);
    return { id, parents, type: 'ins', pos: this.oplog.ops.length - 1, content: value, clientId: this.clientId, ts: Date.now() };
  }

  createLocalOp(prevId: any, value: string): Op {
    // create op descriptor but do not apply locally
    const seq = egw.causalGraph.nextSeqForAgent(this.oplog.cg, this.clientId);
    const id = [this.clientId, seq] as any;
    const parents = egw.getLatestVersion(this.oplog);
    const pos = this.oplog.ops.length; // append
    return { id, parents, type: 'ins', pos, content: value, clientId: this.clientId, ts: Date.now() };
  }

  localDelete(id: any): Op | null {
    // id here may be index/pos
    const pos = typeof id === 'number' ? id : 0;
    egw.localDelete(this.oplog, this.clientId, pos, 1);
    const seq = egw.causalGraph.nextSeqForAgent(this.oplog.cg, this.clientId) - 1;
    const rawId = [this.clientId, seq] as any;
    const parents = egw.getLatestVersion(this.oplog);
    return { id: rawId, parents, type: 'del', pos, clientId: this.clientId, ts: Date.now() };
  }

  getText(): string {
    return egw.checkoutSimpleString(this.oplog as any);
  }

  serialize() { return { clientId: this.clientId, ops: this.oplog.ops.slice(), heads: this.oplog.cg.heads.slice(), cg: this.oplog.cg } }
}
