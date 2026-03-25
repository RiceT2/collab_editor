# Collab Editor Bench

这是一个最小可运行的协同编辑实验仓库，包含：

- 一个 WebSocket 中央协同服务（可切换合并算法）。
- 一个网页协同编辑器（支持在同页模拟多个 Bot 用户）。
- 一个可视化 benchmark 面板（对比不同算法的合并性能指标）。

## 快速开始

1. 安装依赖：

```bash
npm install
```

2. 构建：

```bash
npm run build
```

3. 启动 server（默认 rga）：

```bash
npm run server
```

若要指定算法（例如 plain / ot / json / egwalker / egwalker-ref）：

```bash
npm run server -- ot
```

4. 打开浏览器：

- `http://localhost:8080`

## 网页能力

### 1) 协同编辑（可模拟多个用户）

- 主编辑器连接真实 WebSocket。
- 点击“启动 Bot”后会创建多个额外 WebSocket 客户端，持续随机编辑，可模拟并发用户。

### 2) 合并算法 benchmark

网页可直接触发 `/api/benchmark`，比较多种算法：

- Time Taken To Load and Merge Changes (ms)
- Ram Usage (bytes)
- Storage Size (bytes)
- Converged (是否收敛)

## CLI benchmark（保留）

```bash
npm run bench -- --clients 5 --ops 5000 --algo rga
```

## 常见运行问题

- **只执行了 `npm run server` 但没有先 build**：`server` 读取的是 `dist/server/server.js`，需要先 `npm run build`。
- **把参数写成 `npm run server ot` 无效**：npm 脚本参数需要 `--`，正确写法是 `npm run server -- ot`。
