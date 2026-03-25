// A minimal, intentionally flexible interface for pluggable collaborative
// algorithms. `Op` is left as `any` so different algorithm implementations
// can use their own operation formats.
export type Op = any;

export interface CollabAlgorithm {
  applyRemote(op: Op): void;
  localInsert(prevId: any, value: string): Op;
  // createLocalOp: create an operation object representing the local intent
  // but do NOT apply it locally. Useful when a central server sequences
  // and broadcasts canonical ops.
  createLocalOp?(prevId: any, value: string): Op;
  localDelete(id: any): Op | null;
  getText(): string;
  serialize(): any;
}
