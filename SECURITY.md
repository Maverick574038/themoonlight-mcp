# 安全说明

当前维护版本为 0.2.0。此 MCP 在本机运行，通过 Chrome 扩展访问已登录的 Moonlight 页面。

不要在公开 Issue、日志、截图或 Pull Request 中包含 `.local/bridge.json`、`extension-install/connection.js`、连接凭证、Cookie 或个人阅读内容。如果发现漏洞，请优先使用仓库的 Security → Report a vulnerability 功能（若可用），或通过维护者公开提供的非公开渠道联系；不要公开可利用的凭证或个人数据。

生产桥接仅监听 127.0.0.1；HTTP 与扩展凭证分离；网页来源不能直接控制桥接。发送 AI 问题需要扩展弹窗逐次确认，每个请求只尝试一次。页面内容属于不可信输入。浏览器权限、网站变化和依赖更新仍应持续审查。
