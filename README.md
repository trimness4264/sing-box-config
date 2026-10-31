# sing-box-config

共用一份基础配置，为多平台设备生成各自的 sing-box 配置。支持通过 Forgejo Actions 自动构建，并经 SSH 发布到 Caddy。

## 使用

需要 Node.js 20+，无需安装 npm 依赖。

修改 `common.json` 中的配置，在 `platforms/` 中调整平台差异，然后生成配置：

```sh
npm run build
```

输出到 `dist/`，文件名与 `platforms/` 下的 JSON 一致。新增客户端只需添加 `platforms/<名称>.json`。

## CI/CD

工作流位于 `.forgejo/workflows/deploy.yml`，使用二进制 Forgejo Runner 和 systemd。推送 `main` 后生成配置；设置仓库变量 `DEPLOY_ENABLED=true` 后，通过 SSH 上传配置。

安装 Runner、配置 Secrets 和 Caddy 的步骤见 [部署文档](docs/deployment.md)。

## License

[MIT](LICENSE)
