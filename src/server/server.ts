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

export class CentralServer {
  algoName: string;
  algo: CollabAlgorithm;
  clients: Map<string, ClientCallback>;
  globalSeq: number;
  textState: string;
  useTextMode: boolean;

  constructor(algoName = 'rga') {
    this.algoName = algoName;
    this.useTextMode = algoName === 'plain' || algoName === 'central';
    this.algo = this.useTextMode ? this.createAlgo('server') : this.createAlgo('server');
    this.clients = new Map();
    this.globalSeq = 0;
    this.textState = '';
  }

  createAlgo(clientId: string) {
    if (this.algoName === 'ot') return new OT(clientId) as CollabAlgorithm;
    if (this.algoName === 'json') return new JSONCRDT(clientId) as CollabAlgorithm;
    if (this.algoName === 'eg' || this.algoName === 'egwalker') return new EgWalker(clientId) as CollabAlgorithm;
    if (this.algoName === 'eg-ref' || this.algoName === 'egwalker-ref') return new EgWalkerRef(clientId) as CollabAlgorithm;
    return new RGA(clientId) as CollabAlgorithm;
  }

  connectClient(clientId: string, cb: ClientCallback) {
    this.clients.set(clientId, cb);
    // send initial state? for simplicity, not sending snapshot now
    return () => this.clients.delete(clientId);
  }

  // receive op from a client; sequence and broadcast canonical op to all clients
  receive(clientId: string, op: any, maxDelay = 20) {
    // assign global seq
    const serverTs = Date.now();
    const seq = ++this.globalSeq;
    const canonical = { ...op, __serverSeq: seq, __serverTs: serverTs };

    if (this.useTextMode && canonical.type === 'edit') {
      const from = Math.max(0, Math.min(this.textState.length, canonical.from ?? 0));
      const to = Math.max(from, Math.min(this.textState.length, canonical.to ?? from));
      const insert = canonical.insert ?? '';
      this.textState = this.textState.slice(0, from) + insert + this.textState.slice(to);
    } else {
      this.algo.applyRemote(canonical);
      if (!this.useTextMode && this.algo.getText) {
        this.textState = this.algo.getText();
      }
    }

    // broadcast to all clients (simulate small network delay)
    for (const [id, cb] of this.clients) {
      const delay = Math.floor(Math.random() * maxDelay);
      setTimeout(() => cb({ type: 'op', op: canonical, text: this.textState, version: seq }), delay);
    }
  }

  getState() {
    if (this.useTextMode) {
      return { text: this.textState };
    }
    return this.algo.serialize();
  }

  startWebServer(port = 8080) {
    const server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const htmlPath = join(__dirname, '../../web/index.html');
        res.end(readFileSync(htmlPath));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      const clientId = Math.random().toString(36).substr(2, 9);
      console.log(`Client ${clientId} connected`);

      const disconnect = this.connectClient(clientId, (op) => {
        ws.send(JSON.stringify({ type: 'op', op }));
      });

      // Send initial state
      ws.send(JSON.stringify({ type: 'init', state: { text: this.useTextMode ? this.textState : this.algo.getText() } }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'edit') {
            this.receive(clientId, msg.op);
          } else if (msg.type === 'op') {
            // legacy support from HTML client that sends whole text updates
            if (msg.op && msg.op.type === 'update') {
              const editOp = {
                type: 'edit',
                from: 0,
                to: this.textState.length,
                insert: msg.op.text,
              };
              this.receive(clientId, editOp);
            } else {
              this.receive(clientId, msg.op);
            }
          }
        } catch (e) {
          console.error('Invalid message', e);
        }
      });

      ws.on('close', () => {
        console.log(`Client ${clientId} disconnected`);
        disconnect();
      });
    });

    server.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const algo = process.argv[2] || 'rga';
  const server = new CentralServer(algo);
  server.startWebServer();
}
