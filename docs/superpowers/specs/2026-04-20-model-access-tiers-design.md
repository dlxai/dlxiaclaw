# Model Access Tiers Design

**Date:** 2026-04-20  
**Branch:** feature/credits-system  
**Status:** Approved

## Overview

Users can chat immediately without any setup. The default model is a free OpenRouter model available to everyone. Subscribed users unlock the full OpenRouter model catalog. Any user can add their own provider API key to use external models outside the credits system entirely.

## User Tiers

| | 免费用户 (Free) | 订阅用户 (Pro) | 自定义 Key 用户 |
|---|---|---|---|
| 默认模型 | OpenRouter 免费模型（固定） | 同，可切换 | 自己配置的模型 |
| 模型选择器 | 不显示（只读展示当前模型） | 显示完整列表 | 显示自定义分组 |
| 可用模型范围 | `FREE_MODELS` 列表 | 全量 OpenRouter | 不限（自己的 key）|
| Credits 扣费 | 是（按实际 token 消耗） | 是（按实际 token 消耗） | 否（绕过 credits 系统） |
| Credits 额度 | 有限（免费赠送） | 更高额度 | 无限制 |

## Architecture

### 前端（Desktop Panel）

1. 启动时调用 `/api/me`，获取 `{ tier: "free" | "pro", credits_balance }`
2. `tier === "free"` 且无自定义 key：隐藏模型选择器，状态栏只读展示当前免费模型名
3. `tier === "pro"` 或有自定义 key：显示模型选择器，按分组展示：
   - **[免费模型]** — `FREE_MODELS` 列表（所有用户可用）
   - **[高级模型]** — 全量 OpenRouter 付费模型（仅 Pro）
   - **[自定义]** — 用户自己添加的 provider key

4. Credits 余额显示：仅对 credits 用户（非自定义 key 会话）在聊天界面显示余额
5. 余额不足（`credits_balance <= 0`）时：发送前拦截并提示充值

### 桌面端（Desktop Main Process）

- `getSessionModelInfo(sessionKey)`：
  - `tier === "free"` 且无自定义 key → 返回默认免费模型（`openrouter/meta-llama/llama-3.3-70b-instruct:free`），忽略 session override
  - `tier === "pro"` → session override 优先，否则返回默认免费模型
  - 自定义 key → 走自己的 provider，不经过 credits proxy
- `/api/models` 端点：
  - `tier === "free"` → 只返回 `FREE_MODELS` 列表
  - `tier === "pro"` → 返回完整 OpenRouter catalog + FREE_MODELS

### 云端（cloud-api）

#### `/api/proxy/openrouter`

```
请求进来
├── 验 JWT → 解析 { tier, userId }
├── tier === "free" && model 不在 FREE_MODELS → 返回 403
├── 转发给 OpenRouter（流式）
└── 响应完成（收到 [DONE]）→ 读取 usage → 按 token 价格扣 credits
```

#### Credits 扣费规则

- 扣费发生在**请求完成之后**（先服务，后扣费）
- 流式请求：等待 `data: [DONE]` 事件后从 usage 字段读取消耗
- 非流式请求：从响应 body 的 `usage` 字段读取
- 扣费公式：`cost = (prompt_tokens * input_price + completion_tokens * output_price)`，单位与 credits 换算比例 TBD
- `credits_balance` 扣至 0 后不再允许新请求，返回 402

#### `/api/me`

返回当前用户信息，包含：
```json
{
  "userId": "...",
  "tier": "free" | "pro",
  "credits_balance": 12345,
  "subscription_expires_at": "2026-05-01T00:00:00Z" | null
}
```

JWT 中携带 `tier` claim，proxy 无需额外 DB 查询即可鉴权。订阅状态变更时重新签发 JWT（或在 JWT 过期后自动更新）。

## 自定义服务商

任意用户（免费或订阅）均可在设置页添加自定义服务商：

- 填写字段：服务商名称、Base URL、API Key、协议（`openai` / `anthropic`）、模型 ID 列表
- 添加后出现在模型选择器 **[自定义]** 分组
- 使用自定义 key 的会话：请求直接从桌面端发到对应服务商，**完全绕过 cloud-api credits proxy，不扣任何积分**

## 模型切换作用域

- 切换模型只影响**当前对话**（session override）
- 新对话重置为默认模型
- `tier === "free"` 用户无法切换，session override 不生效

## 关键文件

| 文件 | 职责 |
|---|---|
| `apps/cloud-api/src/config/free-models.ts` | `FREE_MODELS` 权威列表 |
| `apps/cloud-api/src/routes/proxy.ts` | tier 检查 + credits 扣费 |
| `apps/cloud-api/src/routes/me.ts` | 返回 tier + balance |
| `apps/desktop/src/store/llm-provider-manager.ts` | `getSessionModelInfo` tier 逻辑 |
| `apps/desktop/src/api-routes/provider-routes.ts` | `/api/models` 按 tier 过滤 |
| `apps/panel/src/pages/ChatPage.tsx` | 模型选择器显示/隐藏 |
| `apps/panel/src/components/inputs/KeyModelSelector.tsx` | 分组展示逻辑 |

## Open Questions

- Credits 与人民币/美元的换算比例（TBD，由产品决定）
- 订阅到期后的宽限期处理方式
- 免费用户赠送 credits 额度大小
