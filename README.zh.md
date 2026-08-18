# dsh-adaptive-verifier

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自适应验证插件。它将 `LLM-as-a-Verifier` 的连续 logprob 评分思想与确定性证据、部分轨迹级联、自适应重复验证和预算控制组合起来，在工具副作用发生前选择更可靠的下一步，并为已经隔离完成的 Best-of-N 轨迹提供排序服务。

> 状态：`0.1.0` 初始实现。核心、CLI、mock 测试和 Harness 插件接口已完成；仓库不声称已经在 Terminal-Bench 2.1 上复现任何新的准确率或成本数字。DeepSeek Harness 仍处于 developer preview，部署时应固定 Harness 与本插件的提交版本。

[English README](README.md)

## 能力概览

- **`deepseek-verified` 模型路由**：并行生成多个 assistant response，在任何工具调用真正执行之前完成选择，只将获胜 response 交给 Agent Loop。
- **`ctx.adaptiveVerifier` 服务**：比较或排序调用方提供的候选轨迹；适合 git worktree、容器快照或其他隔离环境中的完整 Best-of-N。
- **A–T 连续评分**：读取 `<score_A>` / `<score_B>` 位置的 top-logprobs，对 20 档评分 token 分布求期望，而不是只使用最终离散字母。
- **证据优先**：先检查测试状态、exit code、未解决错误、修改后是否重新验证、artifact 等结构化证据。
- **自适应计算**：仅在 gap 小、熵高、coverage 低、A/B 位置反转后冲突或 criterion 冲突时增加 verifier 调用。
- **双层证据级联**：普通淘汰使用 partial evidence，完整轨迹只留给少量 finalist。
- **显式预算**：分别限制 verifier 请求数、未缓存输入 Token、输出 Token、单次估算输入与 wall-clock 时间。
- **安全缓存**：磁盘缓存以请求哈希作为键，只保存评分结果，不保存原始 prompt 或 trajectory。
- **离线基准 CLI**：ground-truth label 与 selector 输入分离，避免 benchmark label 泄漏。

## 系统结构

```text
DeepSeek Harness request
        │
        ▼
  deepseek-verified adapter
        │
        ├── 并行生成 2 个候选 response
        ├── 去重与确定性检查
        ├── partial-evidence pairwise verification
        ├── 不确定时增加候选 / 反向比较 / 重复验证
        └── 只返回获胜 response
                         │
                         ▼
                Harness 执行工具调用
```

完整轨迹模式是另一条路径：

```text
隔离 worktree/container A ─┐
隔离 worktree/container B ─┼─► adaptiveVerifier.select() ─► 重新测试获胜 artifact ─► 提交
隔离 worktree/container N ─┘
```

插件**不会**假装 Session fork 等价于文件系统 fork。对话历史可以复制，但文件、进程、端口、数据库和外部服务状态必须由调用方隔离。详见 [隔离与提交语义](docs/isolation.md)。

## 安装

### 从本地 checkout 安装到 Harness profile

```bash
git clone https://github.com/keepkeen/dsh-adaptive-verifier.git
cd dsh-adaptive-verifier
npm install
npm run check

dsh plugin --profile verifier-lab add .
dsh --profile verifier-lab --dump-config
```

### 从 GitHub 安装

```bash
dsh plugin --profile verifier-lab add \
  github:keepkeen/dsh-adaptive-verifier#<固定提交 SHA>
```

Git 安装会执行包的 `prepare` 构建脚本；pnpm 10+ 默认要求显式允许该构建。生产环境更推荐安装已审计、已构建的 npm 包或 `npm pack` 生成的 tarball。

## 凭据

```bash
cp .env.example .env
export DEEPSEEK_API_KEY='...'
```

插件直接调用 DeepSeek Chat Completion API，以获取 Harness 通用 `StreamChunk` 当前未暴露的 token logprobs。密钥只从配置指定的环境变量读取，不会进入 Session、prompt、缓存键或日志。

## Harness 配置

Bundle 默认插入 `adaptive-verifier` row。可在 profile 的 `cordis.patch.yml` 中完整覆盖其配置：

```yaml
- id: adaptive-verifier
  name: dsh-adaptive-verifier
  config:
    adapter:
      enabled: true
      provider: deepseek-verified
      generatorModel: deepseek-v4-flash
      initialCandidates: 2
      maxCandidates: 4
      generationTemperature: 0.6
    verification:
      initialRepeats: 1
      maxRepeats: 4
      reverseOnAmbiguity: true
      decisiveGap: 0.12
      decisiveConfidence: 0.72
    budget:
      maxCalls: 12
      maxUncachedInputTokens: 120000
      maxOutputTokens: 40000
      maxWallClockMs: 120000
      maxEstimatedInputTokensPerCall: 90000
    hooks:
      observeSessions: true
      evidenceGate: advisory
      steerBeforeTurnEnd: false
```

然后在当前 profile 的 Agent row 中选择：

```yaml
provider: deepseek-verified
model: deepseek-v4-flash
```

Harness patch 会替换目标 row 的整个 `config`，而不是深度合并，所以覆盖已有 Agent row 时必须保留它所需的其他字段。完整示例见 [`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml)。

## `deepseek-verified` 的运行语义

一次模型步骤会：

1. 并行生成 `initialCandidates` 个 response；
2. 对完全相同的文本与工具调用去重；
3. 使用 action-specific criteria 比较候选；
4. 若 top gap 足够大且 verifier 低熵，则立即停止；
5. 否则最多生成到 `maxCandidates`，已有 comparison 由哈希缓存复用；
6. 汇总生成与验证 Token usage，并把获胜 response 转成标准 Harness chunks；
7. Harness 随后才可能执行获胜 response 中的工具调用。

因此落败候选中的 bash、文件编辑或其他工具调用**不会执行**。

## 轨迹排序服务

插件加载后提供：

```ts
const result = await ctx.adaptiveVerifier.select(
  '修复 failing test，并证明修复有效。',
  [
    { id: 'run-a', content: trajectoryA },
    { id: 'run-b', content: trajectoryB },
    { id: 'run-c', content: trajectoryC },
  ],
  {
    budget: {
      maxCalls: 10,
      maxWallClockMs: 90_000,
    },
  },
)

console.log(result.selectedId)
console.log(result.ranking)
console.log(result.budget)
```

直接比较两个候选：

```ts
const decision = await ctx.adaptiveVerifier.compare(
  task,
  { id: 'a', content: trajectoryA },
  { id: 'b', content: trajectoryB },
)
```

`exactOutcome: 'pass' | 'fail'` 只能用于调用方刚刚运行的、真正可信的精确 checker。不要把 benchmark 隐藏标签作为 `exactOutcome` 传给 selector；基准 CLI 会刻意将 label 保留在选择过程之外。

## CLI

### 提取证据而不调用模型

```bash
npm run build
node dist/src/cli.js \
  --input examples/candidates.json \
  --evidence-only
```

### 运行选择

```bash
export DEEPSEEK_API_KEY='...'
node dist/src/cli.js --input examples/candidates.json
```

安装后也可以使用：

```bash
dsh-adaptive-verify --input candidates.json --output selection.json
```

### 固定 candidate pool 基准

```bash
dsh-adaptive-benchmark \
  --input examples/benchmark.json \
  --output benchmark-result.json
```

该命令报告 Pass@1、selector accuracy、Oracle Pass@N、recovered oracle headroom 和 Token usage。详细协议见 [基准与消融](docs/benchmarking.md)。

## 自适应验证算法

### 1. Evidence extraction

从 trajectory 或 Session event 中提取：

- 测试命令、状态、exit code 与输出尾部；
- 文件/环境修改；
- 未解决异常、failed tests、timeout、permission error 等；
- 修改后是否重新成功验证；
- changed files、tool calls、Agent 成功声明和最终输出。

这些规则是高精度但不完备的 cheap signals，不能代替完整 semantic verification。

### 2. Deterministic pruning

- 调用方提供可信 `exactOutcome='pass'` 时可直接接受；
- 有其他候选存在时可淘汰可信 `exactOutcome='fail'`；
- 完全相同的候选按内容与 artifact 哈希去重；
- 普通日志中的“测试通过”只形成 heuristic score，不默认当作 hidden-test oracle。

### 3. Partial-evidence cascade

候选过多时，先使用 summary、测试证据和 recent trajectory 做 pairwise 淘汰。低成本阶段默认关闭 reasoning；不确定 loser 可以进入 rescue 名额。

### 4. Full finalist round-robin

只在 `finalists` 个候选上读取完整可用轨迹，按多个 criterion 分别评分。每次比较产生：

```text
<score_A>X</score_A>
<score_B>Y</score_B>
```

插件从 X/Y 位置的 top-logprobs 构造 A–T 分布，并计算：

- 期望 reward；
- 分布方差；
- normalized entropy；
- 可见评分 token 的 probability coverage。

### 5. Adaptive repetition

初始只验证一次。以下情况会增加计算：

- reward gap 小；
- confidence 低；
- entropy 高；
- score-token coverage 低；
- criterion 方向冲突；
- A/B 反向后方向冲突。

否则不会机械地运行固定 K 次。

### 6. Calibrated aggregation

默认使用：

```text
P(A > B) = sigmoid((R_A - R_B - slotBias) / temperature)
```

`slotBias` 与 Bradley–Terry temperature 应在独立 calibration set 上拟合。仓库默认值是保守启动值，不是经过 Terminal-Bench 校准后的参数。

## Token 与延迟设计

- criterion 位于 prompt 尾部，使同一 candidate pair 的长前缀可缓存；
- score cache 键包含 model、pair、criterion、evidence level、方向、repeat 和采样配置；
- cache hit 不计入当前运行的 API call 或 Token usage；
- `inputTokens` 表示未缓存输入，`cacheReadTokens` 单独记录；
- action route 先并行生成，验证阶段按缓存友好的顺序运行；
- 达到预算后返回当前最优候选，而不是无上限扩展 verification。

## Hooks

默认启用 Session evidence observation，并以 `advisory` 模式观察高风险或 finalizing 工具调用。

- `off`：不安装 evidence gate；
- `advisory`：记录警告，但允许调用；
- `enforce`：在最新修改后没有成功验证时拒绝匹配的高风险调用。

`steerBeforeTurnEnd` 默认关闭。开启后，若 Agent 修改过状态但尚未重新验证，插件会在 turn 结束前最多 steer 指定次数。生产启用 `enforce` 或自动 steer 前应在自身命令分布上测试误报率。

## 测试

```bash
npm install
npm run check
```

CI 默认运行：

- TypeScript strict typecheck；
- score-token logprob extraction tests；
- evidence extraction tests；
- cache concurrency/persistence tests；
- budget tests；
- adaptive ranker mock tests；
- production build 与 package dry-run。

默认测试不会访问 DeepSeek API。实时 smoke test 需要显式设置 `DEEPSEEK_API_KEY` 并执行 CLI。

## 当前限制

1. DeepSeek Harness 和本插件都处于快速迭代阶段；未承诺跨 breaking change 的二进制兼容。
2. `deepseek-verified` 当前以非流式方式生成候选，再一次性重放获胜 response，因此首 Token 延迟高于普通单路 streaming adapter。
3. 规则式 evidence extraction 只覆盖常见 shell/code-agent 轨迹；垂直领域需要自定义 criterion 与 extractor。
4. top-logprobs 可能只覆盖 A–T 分布的一部分；插件暴露 `coverage` 并在 coverage 低时降低 confidence，但无法恢复 API 没有返回的概率质量。
5. 同模型 generator/verifier 会共享 blind spot。高风险任务应升级到异构 verifier、精确测试或人工审批。
6. 完整 trajectory Best-of-N 的工作区隔离、winner artifact promotion 和最终重测属于调用方职责。
7. 目前没有公开的 Terminal-Bench、SWE-bench 或真实 Harness 性能结果；任何成本/准确率结论必须通过仓库提供的基准协议测量。

## 文档

- [架构与扩展点](docs/architecture.md)
- [API 与配置](docs/api.md)
- [隔离与提交语义](docs/isolation.md)
- [基准与消融](docs/benchmarking.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## License

MIT
