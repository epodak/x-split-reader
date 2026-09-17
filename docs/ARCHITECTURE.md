# Architecture

## 对象与 Morphism

| Object | 输入 | 输出 / 责任 |
|---|---|---|
| `TimelineScanner` | X Timeline DOM | 可见 Tweet 列表与几何位置 |
| `extractDomTweet` | `article[data-testid=tweet]` | Canonical Tweet 快照 |
| `chooseActiveCandidate` | Tweet 矩形 + 阅读线 | 当前候选 Tweet |
| `XSplitReader` | 滚动、点击、模式 | Active Tweet 状态机 |
| `RequestQueue` | 预测窗口 | 有界并发请求序列 |
| `FxTwitterProvider` | Tweet ID / cursor | Conversation payload |
| `normalizeFxConversation` | Provider JSON | Canonical Conversation |
| `TweetCache` | ID + loader | TTL/LRU 数据与 Promise 去重 |
| `DetailRenderer` | Canonical model | 右栏 DOM |

## 状态机

```text
FOLLOW --toolbar click--> PINNED
PINNED --Esc/click------> FOLLOW
```

- `FOLLOW`：滚动阅读线驱动右栏。
- `PINNED`：右栏保持不变，便于深入阅读回复。

## 预加载窗口

当前序列为 `A B [C] D E F` 时，请求优先级为：

1. `C`：当前帖；
2. `D`：向前 +1；
3. `E`：向前 +2；
4. `B`：向后缓存。

只预取评论第一页；后续 cursor 必须由用户在右栏触发。并发上限为 2，避免快速滚动制造无效请求风暴。

## 不变量与失败退化

### 渲染不变量

```text
renderedConversation.id === activeTweet.id
```

每次 active tweet 变化都会递增 request version。旧请求即使稍后成功，也不会提交到右栏。

### 退化路径

```text
DOM 主帖 -> 立即显示
FxTwitter 成功 -> 补充规范化正文、媒体与回复
FxTwitter 失败 -> 保留 DOM 主帖 + Open in X
```

因此外部 API 故障不会破坏原始 Timeline。

## 为什么没有直接合并 xTweaks

xTweaks 的 CSS 与紧凑布局思路适合作为参考，但本项目需要自己的 Focus Tracker、Provider、缓存和渲染状态机。独立实现可以：

- 避免伪造 `innerWidth` 对真实双栏布局的副作用；
- 降低许可证和上游实现耦合；
- 让未来的 Chrome 扩展复用核心模块。

## Chrome 扩展迁移边界

迁移到 Manifest V3 时，可保持以下概念不变：

- Focus / mode 状态机；
- Canonical model；
- Cache 与 prefetch 调度；
- Provider normalization；
- Detail renderer。

需要替换的仅是 userscript metadata、`GM_xmlhttpRequest`、菜单命令和跨域权限声明。

