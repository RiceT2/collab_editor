import { RGA, OT, JSONCRDT, CollabAlgorithm } from '../index.js';
import { CentralServer } from '../server/server.js';
import * as fs from 'fs';
import * as path from 'path';

type ClientSim = {
  id: string;
  doc: CollabAlgorithm;
  inbox: any[];
  sent: number;
};

function perfNow() { return Number(process.hrtime.bigint() / BigInt(1e6)); }

function broadcast(clients: ClientSim[], from: string, op: any, maxDelay = 20, opEvents?: OpEvent[]) {
  for (const c of clients) {
    if (c.id === from) continue;
    const delay = Math.floor(Math.random() * maxDelay);
    setTimeout(() => {
      // measure per-apply latency (end-to-end from creation to application)
      const appliedAt = perfNow();
      const createdAt = op && (op.__createdAt ?? op.ts ?? appliedAt);
      const opId = op && (op.__opId ?? op.id ?? `${from}:${createdAt}`);
      const sender = op && (op.__sender ?? from);
      const latency = createdAt ? (appliedAt - createdAt) : 0;
      // apply remote and record
      c.doc.applyRemote(op);
      c.inbox.push(op);
      latencyRecords.push({ opId: String(opId), from: String(sender), to: c.id, latency, ts: appliedAt });
      if (opEvents) opEvents.push({ kind:'remote', client: c.id, op, timestamp: appliedAt, target: from });
    }, delay);
  }
}

function sampleMemory() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal }; 
}

type OpEvent = { kind:'local'|'remote'|'server', client:string, op:any, timestamp:number, target?:string, note?:string };
const latencyRecords: Array<{opId:string, from:string, to:string, latency:number, ts:number}> = [];
const memorySamples: Array<{ts:number, rss:number, heapUsed:number, heapTotal:number}> = [];

async function run(clientsCount = 5, opsPerClient = 5000, maxDelay = 20, algo = 'rga') {
  const clients: ClientSim[] = [];
  let server: CentralServer | null = null;
  const central = process.argv.includes('--central');
  const opEvents: OpEvent[] = [];
  if (central) {
    server = new CentralServer(algo);
  }
  const sampleIntervalMs = 100;
  let memSampler: NodeJS.Timeout | null = null;
  // per-client size samples (approximate memory footprint via serialized size)
  const perClientSamples: Record<string, Array<{ts:number, size:number}>> = {};
  for (let i = 0; i < clientsCount; i++) {
    const id = `c${i+1}`;
    let doc: CollabAlgorithm;
    if (algo === 'ot') doc = new OT(id) as CollabAlgorithm;
    else if (algo === 'json') doc = new JSONCRDT(id) as CollabAlgorithm;
    else doc = new RGA(id) as CollabAlgorithm;
    clients.push({ id, doc, inbox: [], sent: 0 });
    if (server) {
      // register a callback so server can push canonical ops back to client
      server.connectClient(id, (op:any)=>{
        doc.applyRemote(op);
        // record latency when applied
        const appliedAt = perfNow();
        const createdAt = op && (op.__createdAt ?? op.ts ?? appliedAt);
        latencyRecords.push({ opId: String(op.__opId ?? op.id ?? 's'+op.__serverSeq), from: String(op.__sender ?? 'unknown'), to: id, latency: appliedAt - createdAt, ts: appliedAt });
        opEvents.push({ kind:'remote', client: id, op, timestamp: appliedAt, target: op.__sender });
      });
    }
  }

  const startMem = sampleMemory();
  const startTime = perfNow();
  let reportTimestamp = '';

  // start memory sampling
  memSampler = setInterval(() => {
    const ts = perfNow();
    memorySamples.push({ ts, ...sampleMemory() });
    // record per-client serialized size
    for (const c of clients) {
      try {
        const ser = (c.doc as any).serialize ? JSON.stringify((c.doc as any).serialize()) : c.doc.getText();
        const size = ser ? Buffer.byteLength(ser, 'utf8') : 0;
        perClientSamples[c.id] = perClientSamples[c.id] || [];
        perClientSamples[c.id].push({ ts, size });
      } catch (e) {
        perClientSamples[c.id] = perClientSamples[c.id] || [];
        perClientSamples[c.id].push({ ts, size: 0 });
      }
    }
  }, sampleIntervalMs);

  const totalOps = clientsCount * opsPerClient;
  let appliedOps = 0;

  const opTimes: number[] = [];

  for (const c of clients) {
    // schedule operations
    for (let k = 0; k < opsPerClient; k++) {
      setImmediate(() => {
        // 80% insert, 20% delete
        const doInsert = Math.random() < 0.8;
        if (doInsert) {
          const prevId = null; // append / map depends on algorithm
          const ch = String.fromCharCode(97 + Math.floor(Math.random() * 26));
          if (server) {
            // create op without applying locally and send to server
            const op = (c.doc as any).createLocalOp ? (c.doc as any).createLocalOp(prevId, ch) : c.doc.localInsert(prevId, ch);
            (op as any).__createdAt = perfNow();
            (op as any).__sender = c.id;
            (op as any).__opId = (op as any).__opId ?? (op as any).id ?? `${c.id}:${c.sent}:${(op as any).__createdAt}`;
            c.sent++;
            opEvents.push({ kind:'local', client: c.id, op, timestamp: (op as any).__createdAt, target: 'server' });
            server!.receive(c.id, op, maxDelay);
            opTimes.push(0);
            appliedOps++;
          } else {
            const op = c.doc.localInsert(prevId, ch) as any;
            // stamp op with creation metadata for latency tracking
            op.__createdAt = perfNow();
            op.__sender = c.id;
            op.__opId = op.__opId ?? op.id ?? `${c.id}:${c.sent}:${op.__createdAt}`;
            c.sent++;
            opEvents.push({ kind:'local', client: c.id, op, timestamp: op.__createdAt, target: 'all' });
            const t0 = perfNow();
            broadcast(clients, c.id, op, maxDelay, opEvents);
            opTimes.push(perfNow() - t0);
            appliedOps++;
          }
        } else {
          // attempt delete; how we pick depends on algorithm
          let op = null as any;
          if ((c.doc as any).serialize && algo === 'rga') {
            const visible = (c.doc as any).serialize().nodes.filter((n:any) => n.visible);
            if (visible.length === 0) return;
            const pick = visible[Math.floor(Math.random()*visible.length)];
            op = c.doc.localDelete(pick.id);
          } else if (algo === 'ot') {
            const txt = c.doc.getText();
            if (txt.length === 0) return;
            const pos = Math.floor(Math.random() * txt.length);
            op = c.doc.localDelete(pos);
          } else if (algo === 'json') {
            const entries = (c.doc as any).serialize().entries;
            if (!entries || entries.length === 0) return;
            const pick = entries[Math.floor(Math.random() * entries.length)];
            op = c.doc.localDelete(pick[0]);
          }
            if (op) {
              // stamp deletes too
              (op as any).__createdAt = perfNow();
              (op as any).__sender = c.id;
              (op as any).__opId = (op as any).__opId ?? (op as any).id ?? `${c.id}:${c.sent}:${(op as any).__createdAt}`;
              c.sent++;
              if (server) {
                server.receive(c.id, op, maxDelay);
                opTimes.push(0);
                appliedOps++;
              } else {
                const t0 = perfNow();
                broadcast(clients, c.id, op, maxDelay);
                opTimes.push(perfNow() - t0);
                appliedOps++;
              }
            }
        }
      });
    }
  }

  // wait until a heuristic time: ops * maxDelay + buffer
  const waitMs = Math.max(2000, opsPerClient * maxDelay + 2000);
  await new Promise(r => setTimeout(r, waitMs));

  const endTime = perfNow();
  const endMem = sampleMemory();

  if (memSampler) { clearInterval(memSampler); memSampler = null; }

  // write CSV outputs
  try {
    reportTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const when = reportTimestamp;
    const outDir = process.cwd();
    const latFile = path.join(outDir, `bench-latencies-${algo}-${when}.csv`);
    const memFile = path.join(outDir, `bench-memory-${algo}-${when}.csv`);
      const perClientCsv = path.join(outDir, `bench-memory-clients-${algo}-${when}.csv`);
      const svgFile = path.join(outDir, `bench-memory-clients-${algo}-${when}.svg`);

    // latencies CSV header
    const latHeader = 'opId,from,to,latency_ms,timestamp_ms\n';
    const latRows = latencyRecords.map(r => `${r.opId},${r.from},${r.to},${r.latency},${r.ts}`).join('\n');
    fs.writeFileSync(latFile, latHeader + latRows);

    // memory CSV header
    const memHeader = 'timestamp_ms,rss,heapUsed,heapTotal\n';
    const memRows = memorySamples.map(m => `${m.ts},${m.rss},${m.heapUsed},${m.heapTotal}`).join('\n');
    fs.writeFileSync(memFile, memHeader + memRows);

    // write per-client CSV: columns = ts,<client1>,<client2>,...
    const clientIds = Object.keys(perClientSamples).sort();
    const rows: string[] = [];
    // build timestamp-aligned rows using sample index (samples taken at same ts)
    const sampleCount = memorySamples.length;
    for (let i = 0; i < sampleCount; i++) {
      const ts = memorySamples[i].ts;
      const cols = [String(ts)];
      for (const id of clientIds) {
        const sample = perClientSamples[id][i];
        cols.push(String(sample ? sample.size : ''));
      }
      rows.push(cols.join(','));
    }
    const perClientHeader = ['timestamp_ms', ...clientIds].join(',') + '\n';
    fs.writeFileSync(perClientCsv, perClientHeader + rows.join('\n'));

    // generate a simple SVG line chart combining all clients
    try {
      const svg = generateSVGChart(memorySamples.map(m => m.ts), perClientSamples, clientIds);
      fs.writeFileSync(svgFile, svg);
      console.log('Wrote per-client CSV:', perClientCsv);
      console.log('Wrote per-client SVG:', svgFile);
    } catch (e) {
      console.error('Failed to generate SVG chart:', e);
    }

    console.log('Wrote latency CSV:', latFile);
    console.log('Wrote memory CSV:', memFile);
  } catch (e) {
    console.error('Error writing CSVs:', e);
  }

// utility: generate a simple multi-line SVG chart
function generateSVGChart(timestamps: number[], perClient: Record<string, Array<{ts:number,size:number}>>, clientIds: string[]) {
  const width = 1200;
  const height = 400;
  const margin = { top: 20, right: 20, bottom: 30, left: 60 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  // build series of numeric arrays
  const series = clientIds.map(id => (perClient[id] || []).map(s => s.size || 0));
  const allValues = series.flat();
  const maxV = allValues.length ? Math.max(...allValues) : 1;
  const minV = 0;

  // x scale based on index
  const n = timestamps.length || 1;

  const colors = ['#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00','#ffff33','#a65628','#f781bf'];

  function x(i:number){ return margin.left + (i/(n-1 || 1))*w; }
  function y(v:number){ return margin.top + h - ( (v-minV)/(maxV-minV || 1) )*h; }

  const lines = series.map((arr, idx) => {
    const points = arr.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
    const color = colors[idx % colors.length];
    return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${points}" />`;
  }).join('\n');

  // legend
  const legend = clientIds.map((id, idx) => {
    const color = colors[idx % colors.length];
    return `<g transform="translate(${margin.left + idx*140},${margin.top})"><rect x="0" y="0" width="12" height="12" fill="${color}"/><text x="18" y="10" font-size="12">${id}</text></g>`;
  }).join('\n');

  const yTicks = 5;
  const yLabels = new Array(yTicks).fill(0).map((_,i)=>{
    const v = Math.round(minV + (i/(yTicks-1 || 1))*(maxV-minV));
    return `<text x="${margin.left-10}" y="${y(v)}" font-size="10" text-anchor="end">${v}</text>`;
  }).join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n  <rect width="100%" height="100%" fill="#fff"/>\n  <g>\n    ${lines}\n  </g>\n  <g>${legend}</g>\n  <g>${yLabels}</g>\n  <text x="${width/2}" y="16" text-anchor="middle" font-size="14">Per-client serialized-size over time</text>\n</svg>`;
  return svg;
}

  const duration = (endTime - startTime) / 1000;
  const throughput = appliedOps / duration;
  const avgLatency = opTimes.length ? opTimes.reduce((a,b)=>a+b,0)/opTimes.length : 0;

  console.log('Clients:', clientsCount);
  console.log('Ops/client:', opsPerClient);
  console.log('Total ops (attempted):', totalOps);
  console.log('Applied ops (local applied count):', appliedOps);
  console.log('Duration(s):', duration.toFixed(3));
  console.log('Throughput (ops/s):', Math.round(throughput));
  console.log('Avg local op time (ms):', avgLatency.toFixed(3));
  console.log('Memory start:', startMem);
  console.log('Memory end:', endMem);

  // sanity check: all docs should converge (same visible text)
  const texts = clients.map(c => c.doc.getText());
  const allSame = texts.every(t => t === texts[0]);
  console.log('Converged:', allSame);
  if (!allSame) {
    console.log('Sample texts:', texts.slice(0,5));
  }

  // write HTML report file with embedded charts and stats
  try {
    const htmlFile = path.join(process.cwd(), `bench-report-${algo}-${reportTimestamp}.html`);
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Bench report ${algo} ${reportTimestamp}</title>
  <style>body{font-family:Segoe UI,Arial,sans-serif;margin:16px;}h1{font-size:1.5em;}table{border-collapse:collapse;margin-top:12px;}th,td{border:1px solid #ccc;padding:4px 8px;}code{background:#f5f5f5;padding:2px 4px;border-radius:4px;}</style>
</head>
<body>
  <h1>Benchmark report: ${algo}</h1>
  <p><strong>Timestamp</strong>: ${reportTimestamp}</p>
  <p><strong>Clients</strong>: ${clientsCount}; <strong>Ops/client</strong>: ${opsPerClient}; <strong>Total ops attempted</strong>: ${totalOps}</p>
  <p><strong>Duration (s)</strong>: ${duration.toFixed(3)}; <strong>Throughput (ops/s)</strong>: ${Math.round(throughput)}; <strong>Converged</strong>: ${allSame}</p>
  <h2>Metrics</h2>
  <ul>
    <li>Memory start: <code>${JSON.stringify(startMem)}</code></li>
    <li>Memory end: <code>${JSON.stringify(endMem)}</code></li>
    <li>Applied ops: ${appliedOps}</li>
    <li>Avg local op time (ms): ${avgLatency.toFixed(3)}</li>
  </ul>

  <h2>Final merged versions</h2>
  <ul>
    ${clients.map(c => `<li><strong>${c.id}</strong>: ${JSON.stringify(c.doc.getText())}</li>`).join('')}
  </ul>
  ${server ? `<p><strong>Server state</strong>: ${JSON.stringify(server.getState())}</p>` : ''}

  <h2>Edit timeline</h2>
  <table>
    <thead><tr><th>time</th><th>kind</th><th>client</th><th>target</th><th>op</th></tr></thead>
    <tbody>
      ${opEvents.map(e => `<tr><td>${e.timestamp}</td><td>${e.kind}</td><td>${e.client}</td><td>${e.target||''}</td><td>${JSON.stringify(e.op)}</td></tr>`).join('')}
    </tbody>
  </table>

  <h2>Latency & Memory chart</h2>
  <p>Per-client serialized-size chart (SVG):</p>
  ${generateSVGChart(memorySamples.map(m=>m.ts), perClientSamples, Object.keys(perClientSamples).sort())}

  <h2>Latencies</h2>
  <table>
    <thead><tr><th>opId</th><th>from</th><th>to</th><th>latency</th><th>timestamp</th></tr></thead>
    <tbody>
      ${latencyRecords.slice(0,100).map(r => `<tr><td>${r.opId}</td><td>${r.from}</td><td>${r.to}</td><td>${r.latency}</td><td>${r.ts}</td></tr>`).join('')}
    </tbody>
  </table>
  <p>Only first 100 latency records shown in table; CSV contains full data.</p>
</body>
</html>`;
    fs.writeFileSync(htmlFile, html);
    console.log('Wrote HTML report:', htmlFile);
  } catch (e) {
    console.error('Failed to write HTML report:', e);
  }
}

// simple CLI
const args = process.argv.slice(2);
let clients = 5, ops = 5000, delay = 20, algo = 'rga';
for (let i=0;i<args.length;i++){
  if (args[i]==='--clients') clients = Number(args[++i]);
  if (args[i]==='--ops') ops = Number(args[++i]);
  if (args[i]==='--delay') delay = Number(args[++i]);
  if (args[i]==='--algo') algo = String(args[++i]);
}

run(clients, ops, delay, algo).catch(e=>{ console.error(e); process.exit(1); });
