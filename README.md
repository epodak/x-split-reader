# X Split Reader

把 X/Twitter 桌面网页变成“滚动驱动的 Master–Detail 阅读器”：Timeline 留在左侧，当前阅读位置对应的帖子、媒体与回复自动显示在右侧。

![Status](https://img.shields.io/badge/status-early%20preview-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## 为什么先做油猴脚本

当前性能成本主要来自 X 的虚拟列表、DOM 扫描、评论网络请求和图片渲染，而不是脚本容器。油猴版能最快验证阅读线、预加载和双栏交互；核心对象已经分层，后续迁移到 Manifest V3 扩展时可以保留状态机、缓存、Provider 和 Renderer。

## 已实现

- 隐藏右侧推荐栏，把左导航压缩成图标栏；
- Timeline 继续使用 X 原生页面滚动，不破坏无限加载；
- 35% 视口阅读线自动选择当前帖子；
- 150ms 防抖 + 48px 切换优势，避免边界来回闪烁；
- DOM 立即渲染主帖，FxTwitter Conversation API 异步补充回复；
- 向前预取 2 条、向后保留 1 条；
- 2 路并发、Promise 去重、25 条 LRU/TTL 缓存；
- FOLLOW / PINNED 模式；
- 评论 cursor 手动续页；
- 可拖动分栏线，双击恢复默认宽度；
- `Alt+Shift+X` 开关，`Esc` 退出 PINNED。

## 安装

1. 安装 Tampermonkey 或 Violentmonkey。
2. 打开仓库中的 [`x-split-reader.user.js`](./x-split-reader.user.js)。
3. 点击 Raw，脚本管理器会显示安装页面。
4. 打开或刷新 [x.com](https://x.com/home)。

> 这是早期预览版。X 会频繁修改 DOM，若布局失效请提交 issue，并附浏览器版本、页面 URL 类型和截图。

## 数据与隐私

- 当前主帖直接读取已经显示在 X 页面里的 DOM。
- 为了预加载评论，脚本会把公开 Tweet ID 发送给 `api.fxtwitter.com`。
- 不读取或发送 X Cookie、密码、私信、草稿或认证令牌。
- 不主动调用 X 的私有 GraphQL；这是后续可选 Provider，不是 v0.1 的依赖。

## 工作模型

```text
Timeline DOM -> Tweet ID -> Focus Tracker -> Active Tweet
                                      |-> Prefetch Window
                                      |-> FxTwitter Provider
                                      v
                              Canonical Model -> Detail Pane
```

关键不变量：右栏提交渲染时，`conversation.id` 必须等于当前 `activeTweet.id`。慢请求返回旧帖时会被丢弃，不会出现“新主帖 + 旧评论”。

更完整的对象/状态说明见 [架构文档](./docs/ARCHITECTURE.md)。

## 本地实时开发 (Local Development)

若要在本地 IDE (如 VS Code) 中修改代码并在浏览器即时生效：

1. 打开浏览器扩展管理页面，进入 **Tampermonkey** 详情页，勾选 **“允许访问文件网址”** (Allow access to file URLs)。
2. 在 Tampermonkey 中新建脚本，粘贴 [`local-dev.user.js`](./local-dev.user.js) 的内容（通过 `@require file://...` 直连本地脚本绝对路径）：

```javascript
// ==UserScript==
// @name         X Split Reader (Local Dev)
// @namespace    https://github.com/epodak/x-split-reader
// @version      0.3.0
// @match        https://x.com/*
// @match        https://twitter.com/*
// @connect      api.fxtwitter.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @require      file://D:/_AI/10_DOING/x-split-reader/x-split-reader.user.js
// ==/UserScript==
```

3. 之后在本地编辑保存 `x-split-reader.user.js` 后，在 X 网页按 `F5` 即可直接执行最新代码，无需重复粘贴。

## 本地验证

```bash
pnpm test
pnpm run check
```

本项目不需要构建步骤；仓库根目录的 `.user.js` 就是可安装产物。

## 路线图

- v0.2：X GraphQL 被动捕获与 Provider fallback；
- v0.2：设置面板、阅读线可视化/调节；
- v0.3：网络自适应预取和媒体分级加载；
- v0.4：Manifest V3 Chrome/Edge 扩展封装。

## License

MIT

