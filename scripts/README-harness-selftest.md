# MIR Harness 协议自测
离线验证内置 ACP Agent「MIR Harness」：本地假 OpenAI 兼容服务 + 真 `out/main/agent/index.js` 子进程，无需网络与登录。
```bash
npm run build                                   # 生成 out/main/agent/index.js（约 30s）
node scripts/mir-harness-selftest.mjs           # 全部 PASS 时退出码 0
node scripts/mir-harness-selftest.mjs --verbose # 额外打印子进程 stderr 与假服务请求
```
- 用临时 `HOME` 与临时配置文件（`$TMPDIR/mir-harness-selftest-*`），结束自动删除，不读写 `~/.mir-harness`。
- 失败时打印 agent stderr、假服务收到的剧本序列，以及每条断言的期望值与实际值；若 `initialize` 就失败，先重新 `npm run build`。
