// Vendored (mostly verbatim) from eg-walker reference `src/index.ts`.
// This file exports the core functions used by the EgWalkerRef adapter.
import * as causalGraph from './egwalker_causal_graph.js'

export type ListOp<T = any> = { type: 'ins', pos: number, content: T } | { type: 'del', pos: number }

export interface ListOpLog<T = any> { ops: ListOp<T>[], cg: causalGraph.CausalGraph }

export function createOpLog<T = any>(): ListOpLog<T> { return { ops: [], cg: causalGraph.createCG() } }

export function localInsert<T>(oplog: ListOpLog<T>, agent: string, pos: number, ...content: T[]) {
  const seq = causalGraph.nextSeqForAgent(oplog.cg, agent)
  causalGraph.add(oplog.cg, agent, seq, seq + content.length, oplog.cg.heads)
  for (const val of content) { oplog.ops.push({ type: 'ins', pos, content: val }); pos++ }
}

export function localDelete<T>(oplog: ListOpLog<T>, agent: string, pos: number, len: number = 1) {
  if (len === 0) throw Error('Invalid delete length')
  const seq = causalGraph.nextSeqForAgent(oplog.cg, agent)
  causalGraph.add(oplog.cg, agent, seq, seq + len, oplog.cg.heads)
  for (let i = 0; i < len; i++) oplog.ops.push({ type: 'del', pos })
}

export function pushOp<T>(oplog: ListOpLog<T>, id: causalGraph.RawVersion, parents: causalGraph.RawVersion[], type: 'ins' | 'del', pos: number, content?: T): boolean {
  const entry = causalGraph.addRaw(oplog.cg, id, 1, parents)
  if (entry == null) return false
  if (type === 'ins' && content === undefined) throw Error('Cannot add an insert operation with no content')
  const op: ListOp<T> = type === 'ins' ? { type, pos, content: content! } : { type, pos }
  oplog.ops.push(op)
  return true
}

export function getLatestVersion<T>(oplog: ListOpLog<T>): causalGraph.RawVersion[] { return causalGraph.lvToRawList(oplog.cg, oplog.cg.heads) }

// We also re-export traverse/checkout utilities used later.
// For brevity, we implement a minimal checkout that replays ops in order.
export function checkoutSimpleString(oplog: ListOpLog<string>): string {
  // naive replay ignoring complex merge optimizations
  const out: string[] = []
  for (const op of oplog.ops) {
    if (op.type === 'ins') out.splice(Math.max(0, Math.min(out.length, op.pos)), 0, op.content)
    else if (op.type === 'del') out.splice(Math.max(0, Math.min(out.length - 1, op.pos)), 1)
  }
  return out.join('')
}

export { causalGraph }
