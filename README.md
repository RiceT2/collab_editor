# Collab Editor Bench

This project is a minimal real-time collaboration platform skeleton with a pluggable conflict-resolution algorithm (CRDT) and a benchmark harness for throughput, latency, and memory measurements.

Quick start

1. Install dependencies:

```bash
npm install
```

2. Run the benchmark (defaults: 5 clients, 5000 ops):

```bash
npm run bench -- --clients 5 --ops 5000
```

Options:
- `--clients`: number of simulated clients
- `--ops`: total operations per client
- `--delay`: max network delay in ms (default 20)
- `--algo`: which algorithm to benchmark (`rga` | `ot` | `json` | `egwalker` | `egwalker-ref` | `plain`) (default `rga`)

Run the collaborative Web UI:

```bash
npm run build
npm run server plain
```

Then open `http://localhost:8080` in multiple browsers to edit collaboratively.

Files of interest

- `src/collab/algorithm.ts` — interfaces for operations and algorithms
- `src/collab/rga.ts` — a simple RGA-style CRDT implementation (pluggable)
- `src/benchmark/bench.ts` — benchmark harness measuring throughput, latency, memory

Feel free to swap the algorithm implementation in `src/collab` to test different strategies.
