# X Split Reader

> **把 X / Twitter 桌面网页变成沉浸式 Master–Detail 分栏阅读器。**  
> 保持左侧 Timeline 无损自然滚动，右侧自适应呈现帖子大图与完整评论流；独创书籍级 Typography 语义段落排版，并具备全局弹窗智能避让机制。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.4-1d9bf0.svg)](https://github.com/epodak/x-split-reader)
[![UserScript](https://img.shields.io/badge/UserScript-Tampermonkey%20%7C%20Violentmonkey-green.svg)](https://raw.githubusercontent.com/epodak/x-split-reader/main/x-split-reader.user.js)
[![Node Tests](https://img.shields.io/badge/tests-10%2F10%20passed-success.svg)](./test/core.test.js)

---

## 💡 为什么需要 X Split Reader？

1. **信息流被打断**：在原版 X 浏览长文或讨论时，点击推文会跳转到新页面，看完返回常常丢失原本的时间线滚动位置；
2. **宽屏空间浪费**：现代大屏显示器上，推特主列两边存在极其空旷的无用留白，而右侧趋势栏充满低价值噪音；
3. **空行大坑与文字挤压**：推特长推文的 `\n\n` 在浏览器中会被渲染成一整行高度（~24px）的空白，段间距达 40px+，视觉上像大裂谷；
4. **弹窗与侧边遮挡**：传统分栏插件常常与推特原生的发推弹窗、私信双栏、切换账号菜单严重打架和穿帮。

**X Split Reader** 彻底解决了这些痛点，在保障原生无限加载与流畅度的同时，带来现代专业阅读器般的高级体验。

---

## ✨ 核心特性

- 📖 **滚动驱动的主从分栏 (Master–Detail Flow)**：
  - 左侧时间线使用 X 原生页面滚动，无损保留推特虚拟列表的高效无限加载；
  - 35% 黄金视口阅读线自动锁定当前推文，右侧即时呈现对应的高清大图、多媒体与完整回复流；
  - **150ms 智能防抖 + 48px 切换优势**，避免在两条推文边界来回抖动与频繁切换。

- 🖋️ **书籍级 Typography 语义段落排版引擎**：
  - 独创 **8px 语义段落间距模型 (Paragraph Model)**；
  - 单回车（软换行、诗歌、短行）保留标准 1.58 行高；
  - 双回车及以上自动注入零侵入的微型间距块（`8px`），彻底消除“比文字还高的大空行”与“全部挤在一起的文字墙”两极化问题。

- 🛡️ **全局模态与侧边栏智能避让 (Modal & Sidebar Evasion)**：
  - **侧边栏点击避让**：点击左侧发帖按钮、通知、私信、书签、账号切换或更多菜单时，右侧边栏自动消失，原生弹窗和界面 100% 居中无遮挡展开；
  - **全屏弹窗检测**：通过 CSS `:has()` 零微秒检测 `#layers` 原生弹窗与遮罩，发帖或回复时右侧自动隐隐退让，关闭后平滑无感就位；
  - **多栏页面原生保护**：自动识别私信（`/messages`）和设置等原生双栏页面，自动让位，绝不打架。

- ⚡ **向下悬停优先探索 (Downward Hover Lookahead)**：
  - 顺应人类阅读直觉：鼠标主动向下移入后续推文时，右侧优先切换到该推文预览；
  - 鼠标向上移回已读推文时保持稳定不跳动，兼顾自动化跟随与主动探索。

- 🚀 **智能预取与高效 LRU 缓存**：
  - 依据阅读线向后预取 2 篇、向前保留 1 篇评论数据；
  - 内置并发去重队列与 25 篇带 TTL 的 LRU 内存缓存，快速滚动时零冗余网络请求。

- 💬 **默认纯净评论流 + 主帖按需展开**：
  - 右侧默认仅渲染精彩回复流，避免与左侧主推文视觉重复冗余；提供快捷按钮一键按需展开/收起主帖。

- 🎨 **极简 68px 侧边栏规范化**：
  - 消除推特粗糙冗长的文字导航，收拢为 44px 居中纯净圆形图标；发推按钮重塑为官方羽毛笔图标，如专业客户端般优雅。

- 📏 **自适应流体分栏**：
  - 分栏中线支持自由拖拽调节宽度，自适应各种分辨率屏幕，双击中线瞬间恢复预设黄金宽度。

---

## 📦 快速安装

### 前提条件
已在浏览器中安装脚本管理器：
- [Tampermonkey (油猴)](https://www.tampermonkey.net/)（推荐）
- [Violentmonkey (暴力猴)](https://violentmonkey.github.io/)

### 一键安装
点击下方链接，脚本管理器将自动弹出安装界面，点击 **“安装”** 即可：

👉 **[点击直接安装最新版 x-split-reader.user.js](https://raw.githubusercontent.com/epodak/x-split-reader/main/x-split-reader.user.js)**

安装完成后，打开或刷新 [x.com](https://x.com/home) 即可自动启用。

---

## ⌨️ 快捷键与操作

| 操作 / 快捷键 | 功能说明 |
| :--- | :--- |
| `Alt + Shift + X` | 全局开启 / 停用 X Split Reader 分栏阅读器 |
| `Esc` | 解除推文 PINNED（固定锁定）模式，恢复滚动自动跟随 |
| **单击左侧推文** | 强制激活并在右侧锁定（PINNED）该推文详情 |
| **拖拽分栏中线** | 实时调节左侧时间线宽度，宽度设置自动持久化记忆 |
| **双击分栏中线** | 快速复位到推荐的默认时间线宽度 |
| **油猴扩展菜单** | 可在菜单中快速切换自动跟随、重置宽度、开启/关闭向下悬停探索 |

---

## 🔒 隐私与数据安全

- **主帖纯本地解析**：当前阅读的主帖完全从已经展示在 X 页面上的本地 DOM 提取，不产生额外发包；
- **只读公共数据接入**：为了预取和展示评论，脚本仅将公开的 Tweet ID 发送至开源公共只读网关 `api.fxtwitter.com`；
- **绝对零隐私读取**：**严禁且绝不读取/上传** 任何 X Cookie、用户密码、私信、草稿或账户认证令牌；
- **无破坏性修改**：不侵入 X 的私有 GraphQL 认证逻辑，安全可靠。

---

## 🛠️ 本地热重载开发 (Local Development)

本项目自带完备的本地调试生态，无需繁琐的打包构建流程，在本地 IDE 中保存代码后直接在浏览器按 `F5` 即可秒级生效：

1. 打开浏览器扩展管理，进入 **Tampermonkey** 详情页，勾选 **“允许访问文件网址”** (Allow access to file URLs)；
2. 复制一份模板：
   ```bash
   cp local-dev.user.example.js local-dev.user.js
   ```
   （`local-dev.user.js` 已被 `.gitignore` 忽略，绝不会误提交本机绝对路径）
3. 修改 `local-dev.user.js` 中的 `@require` 为你本地仓库的绝对路径，例如：
   - **Windows**: `file://D:/path/to/x-split-reader/x-split-reader.user.js`
   - **macOS/Linux**: `file:///Users/username/path/to/x-split-reader/x-split-reader.user.js`
4. 在 Tampermonkey 中新建脚本，粘贴 `local-dev.user.js` 内容并保存；
5. 之后在本地编辑 `x-split-reader.user.js` 并保存，在推特页面按 **F5** 即可即时加载最新逻辑！

---

## 🧪 自动化测试与检查

项目采用轻量且健壮的测试驱动开发，确保核心算法与数据模型稳定：

```bash
# 执行语法静态检查
pnpm run check

# 执行完整单元测试套件
pnpm test
```

测试覆盖了 Tweet 提取算法、阅读线距离仲裁器、LRU 缓存并发去重、FxTwitter 数据模型归一化、书籍级 Typography 段落切分、原生 TextNode 8px 间隔注入、多栏路由判断等 10 项全生命周期关键断言。

---

## 🗺️ 后续演进路线

- [x] v0.1: Master–Detail 分栏架构与阅读线滑动驱动
- [x] v0.2: 智能预加载、LRU 缓存与 68px 纯净导航栏
- [x] v0.3: 向下悬停探索 (Hover Lookahead)、主帖按需收起、Typography 8px 语义排版模型、全局弹窗智能避让
- [ ] v0.4: 设置面板 UI，支持自定义阅读线高比例与段间距参数
- [ ] v0.5: 打包发布 Manifest V3 Chrome / Edge 官方扩展商店版本

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。欢迎 Star、提交 Issue 或发起 Pull Request！
