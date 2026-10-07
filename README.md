# pi pane

M0 Spike：在浏览器里查看并操作正在运行的 pi TUI 会话。宿主基线为 pi 1.0.4。

M0 有界 Spike 验收已完成；完整分页、内容引用和 M1/M2 发布验收尚未完成。性能与已知过载限制见验收记录。

项目资料和任务状态见 [ChatGPT Space](https://chatgpt.com/space/page_6ac669a979c48191a25f7d5411b378f6)，本地设计见 [docs/design.md](docs/design.md)。阶段验收见 [docs/m0-status.md](docs/m0-status.md)。

## 构建与运行

```sh
npm ci --ignore-scripts
npm run build
pi -e .
```

在 pi 终端中运行 `/web`，或启动时传入 `--web --web-no-open`。`/web stop` 停止服务，`/web status` 查看状态，`/web --rotate` 更换访问 token。显式端口可用 `/web --port 7878 --no-open` 或启动参数 `--web-port 7878` 指定。

M0 只允许回环监听。浏览器收到真实消息事件后展示消息，`dispatched` 回执仅表示扩展已调用宿主。网页保留原提交，断线后不会自动重新提交。

## 配置

M0 通过公开的 `pi.getSettings()` 读取 `settings.json` 中的配置：

```json
{
  "piPane": {
    "host": "127.0.0.1",
    "port": 7878,
    "noOpen": true
  }
}
```

配置不会自动启动服务，仍需 `/web` 或 `--web`。命令参数覆盖启动 flags，flags 覆盖宿主合并后的设置，再使用默认值。全局与可信项目配置的合并由 pi 控制。

扩展只读取这些设置，不自动改写宿主文件。修改设置后运行 `/reload`；更改正在运行的监听地址时先 `/web stop`，再 `/web`。未知字段、错误类型和非回环地址会报错。

## 验证

```sh
npm run typecheck
npm test
npm run m0:smoke
npm run m0:browser
npm run m0:lifecycle
npm run m0:boundaries
npm run m0:projection
npm run m0:performance
```

集成检查在独立临时配置与空工作目录中启动真实 pi TUI，使用本地确定性 provider。不会继承真实模型凭据或调用真实模型。浏览器脚本使用 Playwright 和本机 Chrome。

脱敏日志、JSON 报告和截图写入 `build-artifacts/m0/`。原始生成目录不提交。M0 采用有界历史与纯文本内容预览，完整分页、Markdown/diff、图片和远程访问属于后续阶段。

## 工程结构

- `src/extension/`：进程级 Hub、会话 Bridge 与 pi 扩展入口。
- `src/protocol/`：协议类型、校验与资源上限。
- `src/web/`：浏览器界面、实时状态与提交记录。
- `tests/fixtures/`：隔离确定性 provider。
- `scripts/`：真实 PTY 与浏览器验收脚本。
- `docs/project.json`：Space、执行计划、证据页与本地跟进任务的关联。
