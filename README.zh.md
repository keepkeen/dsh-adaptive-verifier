# dsh-adaptive-verifier

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自适应验证插件。0.2.0 的核心设计是：**生成模型路由和验证模型路由彻底解耦，主插件不再假设 Harness 当前模型来自 DeepSeek，也不读取或推断任何 provider 的 API Key。**

[English README](README.md)

## 为什么要这样改

Harness 当前会话可能是：

- `deepseek-official`；
- OpenRouter 上的 DeepSeek；
- OpenAI-compatible gateway；
- Anthropic / OpenAI / 其他供应商；
- 本地 vLLM / 自定义 adapter。

因此不能看到一个 model id 就把它解释成 DeepSeek 官方 HTTP，也不能把当前 provider 的 credential 当作 `DEEPSEEK_API_KEY`。

## 正确的三层结构

### 1. Generator route

候选生成永远继承当前 Harness agent 已经选择的 provider/model：

```text
当前 Harness provider/model
        ├── Candidate A
        ├── Candidate B
        └── Candidate N
```

插件不改 provider，不复制 Key。

### 2. Verifier route

验证路由单独配置。默认：

```yaml
verifier:
  backend: harness
```

provider/model 省略时，verifier **通过 Harness** 跟随当前 agent route。虽然路由相同，但 credential 仍由 Harness adapter 自己处理，插件看不到 Key。

也可以固定一个完全独立的 verifier：

```yaml
verifier:
  backend: harness
  provider: deepseek-official
  model: deepseek-v4-flash
```

此时即使 generator 是 OpenRouter / Anthropic / 本地模型，verifier 仍走指定的 Harness route。对应 Key 仍由那个 Harness adapter 管理。

### 3. Verifier backend

默认 `backend: harness` 是 provider-agnostic 的。主插件调用 `ctx.llm`，不解析 credential。

Harness 通用 `StreamChunk` 当前不暴露 token logprobs，所以通用 backend 使用 A–T 离散评分 + 自适应 criteria/repeat 来估计稳定性。

如果明确需要论文里的连续 logprob 评分，再显式启用 provider-specific backend：

```yaml
verifier:
  backend: deepseek-logprob
  model: deepseek-v4-flash
```

这时才启用 DeepSeek HTTP/logprob 代码，并使用它自己的 `deepseek.*` 配置 / `DSH_VERIFIER_DEEPSEEK_API_KEY`。**不会从当前 generator route 猜 Key、猜 endpoint 或猜 model。**

## 推荐安装

```bash
git clone https://github.com/keepkeen/dsh-adaptive-verifier.git
cd dsh-adaptive-verifier
npm install --legacy-peer-deps
npm run check

dsh plugin --profile verifier-lab add .
dsh --profile verifier-lab --dump-config
```

不需要把 Harness 模型切换成 `deepseek-verified`。继续正常使用原来的模型选择即可。

## 推荐配置

```yaml
- id: adaptive-verifier
  config:
    adapter:
      enabled: true
      transparent: true
      # 空数组 = 对所有 agent-loop provider 生效
      targetProviders: []
      initialCandidates: 2
      maxCandidates: 4
      generationTemperature: 0.6

    verifier:
      backend: harness
      # provider/model 留空 = 通过 Harness 跟随当前 route

    verification:
      initialRepeats: 1
      maxRepeats: 4
      reverseOnAmbiguity: true

    hooks:
      observeSessions: true
      evidenceGate: advisory
      steerBeforeTurnEnd: false
```

如果希望“生成模型随用户切换，但 verifier 永远固定一个便宜模型”，可以：

```yaml
verifier:
  backend: harness
  provider: deepseek-official
  model: deepseek-v4-flash
```

## 实际数据流

```text
User
 ↓
Harness 当前 agent provider/model
 ↓
候选 A/B/... 仍通过同一个 Harness route 生成
 ↓
Adaptive Verifier
 ├─ 默认：ctx.llm → 独立/继承 verifier route → Harness 自己处理 credential
 └─ 可选：显式 provider-specific logprob backend
 ↓
Winner
 ↓
Harness Agent Loop
 ↓
只执行 Winner 的 tool calls
```

## Key 的原则

正常 Harness 模式下：

```text
插件主逻辑
  ❌ 不读取当前 generator 的任何 API Key
  ❌ 不读取 OpenRouter Key
  ❌ 不读取 Anthropic Key
  ❌ 不从 model 名推断供应商
  ❌ 不从 generator route 复制 credential

Harness adapter
  ✅ 自己解析 provider 配置
  ✅ 自己读取对应 credential
  ✅ 自己发送网络请求
```

只有显式选择 `deepseek-logprob` 这种 provider-specific backend 时，才需要那一 backend 自己的 credential 配置；默认引用名为 `DSH_VERIFIER_DEEPSEEK_API_KEY`，与 generator/provider 凭据明确分离。

## 兼容性

透明拦截只针对 Harness 标记的 agent-loop request；session title、compaction、插件内部 verifier 请求不会再次进入候选验证，避免递归。

## 当前限制

1. Harness-native verifier 没有 token logprob，因此不是论文连续 reward 的完全等价实现；它通过离散 A–T + adaptive repeats 折中。
2. provider-specific logprob 应逐个后端实现，不能假设所有供应商 API 都有相同字段。
3. 完整 trajectory Best-of-N 仍需要独立 worktree/container 隔离。

## License

MIT
