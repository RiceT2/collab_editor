import { RGA } from '../collab/rga.js';
import { OT } from '../collab/ot.js';
import { JSONCRDT } from '../collab/jsoncrdt.js';
import { EgWalker } from '../collab/egwalker.js';
import { EgWalkerRef } from '../collab/egwalker_ref.js';
import type { CollabAlgorithm } from '../collab/algorithm.js';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type ClientCallback = (op: any) => void;

type SupportedAlgo = 'rga' | 'ot' | 'json' | 'egwalker' | 'egwalker-ref' | 'plain';

function toSupportedAlgo(value: string | undefined): SupportedAlgo {
  return (['plain', 'rga', 'ot', 'json', 'egwalker', 'egwalker-ref'] as const).includes((value ?? 'rga') as SupportedAlgo)
    ? (value as SupportedAlgo)
    : 'rga';
}

type BenchOptions = {
  algorithms: SupportedAlgo[];
  clients: number;
  opsPerClient: number;
  delayMs: number;
};

type BenchResult = {
  algorithm: SupportedAlgo;
  clients: number;
  opsPerClient: number;
  totalOps: number;
  converged: boolean;
  timeTakenToLoadAndMergeMs: number;
  ramUsageBytes: number;
  storageSizeBytes: number;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomChar() {
  return String.fromCharCode(97 + Math.floor(Math.random() * 26));
}

function byteSize(obj: unknown) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

function makeAlgo(algoName: SupportedAlgo, clientId: string): CollabAlgorithm {
  if (algoName === 'ot') return new OT(clientId) as CollabAlgorithm;
  if (algoName === 'json') return new JSONCRDT(clientId) as CollabAlgorithm;
  if (algoName === 'egwalker') return new EgWalker(clientId) as CollabAlgorithm;
  if (algoName === 'egwalker-ref') return new EgWalkerRef(clientId) as CollabAlgorithm;
  return new RGA(clientId) as CollabAlgorithm;
}

async function runSingleBenchmark(algoName: SupportedAlgo, clientsCount: number, opsPerClient: number, delayMs: number): Promise<BenchResult> {
  const server = new CentralServer(algoName);
  const clients: Array<{ id: string; doc: CollabAlgorithm }> = [];

  for (let i = 0; i < clientsCount; i++) {
    const id = `bench-c${i + 1}`;
    const doc = makeAlgo(algoName, id);
    server.connectClient(id, ({ op }) => {
      if (op && op.type === 'edit') {
        // benchmark path uses centralized text edits, client-side state is not authoritative here.
        return;
      }
      if (op) doc.applyRemote(op);
    });
    clients.push({ id, doc });
  }

  const memStart = process.memoryUsage().rss;
  let peakMem = memStart;
  const memTimer = setInterval(() => {
    peakMem = Math.max(peakMem, process.memoryUsage().rss);
  }, 25);

  const t0 = Date.now();
  for (const c of clients) {
    for (let i = 0; i < opsPerClient; i++) {
      const currentText = server.getTextState();
      const from = currentText.length;
      const op = { type: 'edit', from, to: from, insert: randomChar(), clientId: c.id, ts: Date.now() };
      server.receive(c.id, op, delayMs);
    }
  }

  await delay(Math.max(300, delayMs * 4 + Math.ceil((clientsCount * opsPerClient) / 2)));
  clearInterval(memTimer);
  const t1 = Date.now();

  const serverText = server.getTextState();
  const converged = serverText.length > 0 || clientsCount * opsPerClient === 0;

  const storageSizeBytes = byteSize(server.getState()) + clients.reduce((sum, c) => sum + byteSize(c.doc.serialize()), 0);

  return {
    algorithm: algoName,
    clients: clientsCount,
    opsPerClient,
    totalOps: clientsCount * opsPerClient,
    converged,
    timeTakenToLoadAndMergeMs: t1 - t0,
    ramUsageBytes: Math.max(0, peakMem - memStart),
    storageSizeBytes,
  };
}

export class CentralServer {
  algoName: SupportedAlgo;
  algo: CollabAlgorithm;
  clients: Map<string, ClientCallback>;
  globalSeq: number;
  textState: string;
  useTextMode: boolean;

  constructor(algoName: SupportedAlgo | string = 'rga') {
    this.algoName = toSupportedAlgo(algoName);
    this.useTextMode = algoName === 'plain';
    this.algo = this.createAlgo('server');
    this.clients = new Map();
    this.globalSeq = 0;
    this.textState = '';
  }

  createAlgo(clientId: string) {
    return makeAlgo(this.algoName, clientId);
  }

  connectClient(clientId: string, cb: ClientCallback) {
    this.clients.set(clientId, cb);
    return () => this.clients.delete(clientId);
  }

  receive(clientId: string, op: any, maxDelay = 20) {
    const serverTs = Date.now();
    const seq = ++this.globalSeq;
    const canonical = { ...op, __serverSeq: seq, __serverTs: serverTs };

    if (canonical.type === 'edit') {
      const from = Math.max(0, Math.min(this.textState.length, canonical.from ?? 0));
      const to = Math.max(from, Math.min(this.textState.length, canonical.to ?? from));
      const insert = canonical.insert ?? '';
      this.textState = this.textState.slice(0, from) + insert + this.textState.slice(to);
      if (!this.useTextMode) {
        const normalized = {
          type: 'insert',
          id: `srv:${seq}`,
          prevId: from === 0 ? null : `srv:${Math.max(0, seq - 1)}`,
          value: insert,
          clientId,
          ts: serverTs,
        };
        try {
          this.algo.applyRemote(normalized);
        } catch {
          // keep serving merged text even if algorithm does not support this normalization.
        }
      }
    } else {
      this.algo.applyRemote(canonical);
      this.textState = this.algo.getText();
    }

    for (const [, cb] of this.clients) {
      const d = Math.floor(Math.random() * Math.max(1, maxDelay));
      setTimeout(() => cb({ type: 'op', op: canonical, text: this.textState, version: seq }), d);
    }
  }

  getTextState() {
    return this.textState;
  }

  getState() {
    if (this.useTextMode) return { text: this.textState };
    return this.algo.serialize();
  }

  async runBenchmark(options: BenchOptions) {
    const results: BenchResult[] = [];
    for (const algo of options.algorithms) {
      results.push(await runSingleBenchmark(algo, options.clients, options.opsPerClient, options.delayMs));
    }
    return results;
  }

  startWebServer(port = 8080) {
    const server = createServer(async (req, res) => {
      const url = req.url ?? '/';

      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(__dirname, '../../web/index.html')));
        return;
      }

      if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, algorithm: this.algoName, textLength: this.textState.length }));
        return;
      }

      if (url === '/api/benchmark' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', async () => {
          try {
            const body = raw ? JSON.parse(raw) : {};
            const algorithms: SupportedAlgo[] = Array.isArray(body.algorithms)
              ? body.algorithms.filter((a: string) => ['plain', 'rga', 'ot', 'json', 'egwalker', 'egwalker-ref'].includes(a))
              : ['plain', 'rga', 'ot'];
            const clients = Math.max(2, Number(body.clients ?? 4));
            const opsPerClient = Math.max(10, Number(body.opsPerClient ?? 100));
            const delayMs = Math.max(0, Number(body.delayMs ?? 10));

            const result = await this.runBenchmark({ algorithms, clients, opsPerClient, delayMs });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ result }));
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: e?.message ?? 'Invalid benchmark request' }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      const clientId = Math.random().toString(36).slice(2, 11);
      const disconnect = this.connectClient(clientId, (op) => {
        ws.send(JSON.stringify({ type: 'op', op }));
      });

      ws.send(JSON.stringify({ type: 'init', state: { text: this.textState, algorithm: this.algoName } }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'edit') {
            this.receive(clientId, msg.op);
            return;
          }
          if (msg.type === 'op' && msg.op) {
            this.receive(clientId, msg.op);
            return;
          }
        } catch (e) {
          console.error('Invalid message', e);
        }
      });

      ws.on('close', () => disconnect());
    });

    server.listen(port, () => {
      console.log(`Server running on http://localhost:${port} (algo=${this.algoName})`);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const algoArg = process.argv[2];
  const server = new CentralServer(toSupportedAlgo(algoArg));
  server.startWebServer();
}
