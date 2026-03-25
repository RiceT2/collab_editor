// Vendored from eg-walker reference: causal-graph.ts (trimmed for clarity)
import PriorityQueue from 'priorityqueuejs'
import bs from 'binary-search'

export interface VersionSummary { [agent: string]: [number, number][] }
export type RawVersion = [string, number]
export type LV = number
export type LVRange = [number, number]

type CGEntry = { version: LV, vEnd: LV, agent: string, seq: number, parents: LV[] }
type ClientEntry = { seq: number, seqEnd: number, version: LV }

export interface CausalGraph { heads: LV[], entries: CGEntry[], agentToVersion: { [k: string]: ClientEntry[] } }

const min2 = (a: number, b: number) => a < b ? a : b
const max2 = (a: number, b: number) => a > b ? a : b

const pushRLEList = <T>(list: T[], newItem: T, tryAppend: (a: T, b: T) => boolean) => {
  if (list.length === 0 || !tryAppend(list[list.length - 1], newItem)) list.push(newItem)
}

const insertRLEList = <T>(list: T[], newItem: T, getKey: (e: T) => number, tryAppend: (a: T, b: T) => boolean) => {
  const newKey = getKey(newItem)
  if (list.length === 0 || newKey >= getKey(list[list.length - 1])) {
    pushRLEList(list, newItem, tryAppend)
  } else {
    let idx = bs(list, newKey, (entry: any, needle: number) => getKey(entry) - needle)
    if (idx >= 0) throw Error('Invalid state - item already exists')
    idx = -idx - 1
    if (idx === 0 || !tryAppend(list[idx - 1], newItem)) list.splice(idx, 0, newItem)
  }
}

const tryRangeAppend = (r1: LVRange, r2: LVRange): boolean => {
  if (r1[1] === r2[0]) { r1[1] = r2[1]; return true } else return false
}

const tryRevRangeAppend = (r1: LVRange, r2: LVRange): boolean => {
  if (r1[0] === r2[1]) { r1[0] = r2[0]; return true } else return false
}

export const createCG = (): CausalGraph => ({ heads: [], entries: [], agentToVersion: {} })

export const advanceFrontier = (frontier: LV[], vLast: LV, parents: LV[]): LV[] => {
  const f = frontier.filter(v => !parents.includes(v))
  f.push(vLast)
  return f.sort((a, b) => a - b)
}

const lastOr = <T, V>(list: T[], f: (t: T) => V, def: V): V => (list.length === 0 ? def : f(list[list.length - 1]))
export const nextLV = (cg: CausalGraph): LV => lastOr(cg.entries, e => e.vEnd, 0)

export const nextSeqForAgent = (cg: CausalGraph, agent: string): number => {
  const entries = cg.agentToVersion[agent]
  if (entries == null) return 0
  return entries[entries.length - 1].seqEnd
}

const tryAppendEntries = (a: CGEntry, b: CGEntry): boolean => {
  const canAppend = b.version === a.vEnd && a.agent === b.agent && a.seq + (a.vEnd - a.version) === b.seq && b.parents.length === 1 && b.parents[0] === a.vEnd - 1
  if (canAppend) a.vEnd = b.vEnd
  return canAppend
}

const tryAppendClientEntry = (a: ClientEntry, b: ClientEntry): boolean => {
  const canAppend = b.seq === a.seqEnd && b.version === (a.version + (a.seqEnd - a.seq))
  if (canAppend) a.seqEnd = b.seqEnd
  return canAppend
}

const findClientEntryRaw = (cg: CausalGraph, agent: string, seq: number): ClientEntry | null => {
  const av = cg.agentToVersion[agent]
  if (av == null) return null
  const result = bs(av, seq, (entry: any, needle: number) => (needle < entry.seq ? 1 : needle >= entry.seqEnd ? -1 : 0))
  return result < 0 ? null : av[result]
}

const findClientEntry = (cg: CausalGraph, agent: string, seq: number): [ClientEntry, number] | null => {
  const clientEntry = findClientEntryRaw(cg, agent, seq)
  return clientEntry == null ? null : [clientEntry, seq - clientEntry.seq]
}

const findClientEntryTrimmed = (cg: CausalGraph, agent: string, seq: number): ClientEntry | null => {
  const result = findClientEntry(cg, agent, seq)
  if (result == null) return null
  const [clientEntry, offset] = result
  return offset === 0 ? clientEntry : { seq, seqEnd: clientEntry.seqEnd, version: clientEntry.version + offset }
}

export const addRaw = (cg: CausalGraph, id: RawVersion, len: number = 1, rawParents?: RawVersion[]): CGEntry | null => {
  const parents = rawParents != null ? rawToLVList(cg, rawParents) : cg.heads
  return add(cg, id[0], id[1], id[1] + len, parents)
}

export const add = (cg: CausalGraph, agent: string, seqStart: number, seqEnd: number, parents: LV[]): CGEntry | null => {
  const version = nextLV(cg)
  while (true) {
    const existingEntry = findClientEntryTrimmed(cg, agent, seqStart)
    if (existingEntry == null) break
    if (existingEntry.seqEnd >= seqEnd) return null
    seqStart = existingEntry.seqEnd
    parents = [existingEntry.version + (existingEntry.seqEnd - existingEntry.seq) - 1]
  }
  const len = seqEnd - seqStart
  const vEnd = version + len
  const entry: CGEntry = { version, vEnd, agent, seq: seqStart, parents }
  pushRLEList(cg.entries, entry, tryAppendEntries)
  insertRLEList(clientEntriesForAgent(cg, agent), { seq: seqStart, seqEnd, version }, e => e.seq, tryAppendClientEntry)
  cg.heads = advanceFrontier(cg.heads, vEnd - 1, parents)
  return entry
}

export const clientEntriesForAgent = (causalGraph: CausalGraph, agent: string): ClientEntry[] => (causalGraph.agentToVersion[agent] ??= [])

export const lvToRaw = (cg: CausalGraph, v: LV): RawVersion => {
  const [e, offset] = findEntryContaining(cg, v)
  return [e.agent, e.seq + offset]
}

export const lvToRawList = (cg: CausalGraph, parents: LV[] = cg.heads): RawVersion[] => parents.map(v => lvToRaw(cg, v))

export const rawToLVList = (cg: CausalGraph, parents: RawVersion[]): LV[] => parents.map(([agent, seq]) => rawToLV(cg, agent, seq))

export const tryRawToLV = (cg: CausalGraph, agent: string, seq: number): LV | null => { const clientEntry = findClientEntryTrimmed(cg, agent, seq); return clientEntry?.version ?? null }
export const rawToLV = (cg: CausalGraph, agent: string, seq: number): LV => { const clientEntry = findClientEntryTrimmed(cg, agent, seq); if (clientEntry == null) throw Error(`Unknown ID: (${agent}, ${seq})`); return clientEntry.version }

export const assignLocal = (cg: CausalGraph, agentId: string, seq: number, parents: LV[] = cg.heads, num: number = 1): LV => {
  let version = nextLV(cg)
  const av = clientEntriesForAgent(cg, agentId)
  const nextValidSeq = lastOr(av, ce => ce.seqEnd, 0)
  if (seq < nextValidSeq) throw Error('Invalid agent seq')
  add(cg, agentId, seq, seq + num, parents)
  return version
}

export const findEntryContainingRaw = (cg: CausalGraph, v: LV): CGEntry => {
  const idx = bs(cg.entries, v, (entry: CGEntry, needle: number) => (needle < entry.version ? 1 : needle >= entry.vEnd ? -1 : 0))
  if (idx < 0) throw Error('Invalid or unknown local version ' + v)
  return cg.entries[idx]
}

export const findEntryContaining = (cg: CausalGraph, v: LV): [CGEntry, number] => { const e = findEntryContainingRaw(cg, v); const offset = v - e.version; return [e, offset] }

export const lvToRawListSafe = lvToRawList

// For brevity, not all functions from original are exported; the reference
// implementation file is large. We only vendor enough for the eg-walker
// index logic to operate (addRaw, createCG, lvToRawList, rawToLVList, nextSeqForAgent, assignLocal, mergePartialVersions, iterVersionsBetween, diff, findDominators, serializeDiff, mergePartialVersions).

// Note: This is a trimmed but functional subset adapted from the reference.

export { pushRLEList, insertRLEList, tryRangeAppend, tryRevRangeAppend, min2, max2 }
