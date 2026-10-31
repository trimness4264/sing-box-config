# Forgejo 推送后自动发布

适用拓扑：Forgejo 为 `https://git.example.com`，Runner 在另一台 Linux 服务器上使用官方二进制加 systemd 运行，任务使用 host 模式，配置通过 SSH 发布到 Caddy 所在服务器。下面按 Debian/Ubuntu 的 systemd 环境编写。

```text
本地修改 → push main → Forgejo Actions → systemd 管理的 Runner
                                      → 生成配置并检查引用
                                      → SSH 上传 → 校验 SHA-256 → 原子切换 current
                                                               ↓
                                                        Caddy HTTPS 配置 URL
```

工作流在 `.forgejo/workflows/deploy.yml`，`main` 分支 push 或在 `main` 手动运行时生成配置。公开参考版默认跳过实际发布；仅当仓库 Actions Variable `DEPLOY_ENABLED` 为字符串 `true` 时才通过 SSH 上传。生成文件不会提交回 Git，也不会作为公开构建产物上传。

## 1. 在 Forgejo 创建这个仓库专用的 Runner

生成和上传会自动扫描 `platforms/` 下的所有 `.json` 文件，输出使用相同文件名。新增客户端只需添加对应的平台差异文件，例如 `platforms/android.json`；没有差异时填写 `{"operations": []}`。文件名使用英文字母、数字、点、连字符或下划线，并以字母或数字开头。下方 Caddy 示例已匹配这些文件名，无需逐个平台添加路径。

打开：

`https://git.example.com/OWNER/sing-box-config/settings/actions/runners`

如果仓库的 Actions 尚未启用，先在仓库设置中启用。选择创建 Runner，命名为 `sing-box-config`。Forgejo 16 会显示 Runner 的 UUID 和 Token，稍后填入服务器的本地配置文件。这是仓库专用 Runner，无需注册为整个实例的公共 Runner。

## 2. 在 Runner 服务器安装二进制并启动 systemd 服务

### 2.1 网络与基础工具

Runner 主动通过 HTTPS 连接 Forgejo 并领取任务、回传日志。Forgejo 不会主动连接 Runner，所以 Runner 无需开放公网入站端口。Runner 需要能访问：

| 目标 | 用途 |
| --- | --- |
| `git.example.com:443` | 领取任务、拉取仓库、回传结果 |
| GitHub HTTPS | 下载工作流使用的 checkout action |
| Caddy 服务器的 SSH 端口 | 上传配置，默认 22 |

在 Runner 服务器执行：

```sh
sudo apt-get update
sudo apt-get install -y git openssh-client ca-certificates curl xz-utils gnupg
```

### 2.2 安装 Node.js

需要系统级的 Node.js 20+ 和 npm，推荐使用 Node.js 22。systemd 服务的 PATH 是 `/usr/local/bin:/usr/bin:/bin`，不会加载登录用户的 nvm 配置。已安装合适版本时可跳过下载，直接检查 `node --version` 和 `npm --version`。

以下从 Node.js 官方下载固定版本，支持 x86_64 和 ARM64：

```sh
NODE_INSTALL_DIR=$(mktemp -d)
cd "$NODE_INSTALL_DIR"
case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) echo '不支持的架构'; exit 1 ;;
esac
NODE_VERSION=22.23.4
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
curl -fSLO "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
curl -fSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
awk -v file="$NODE_ARCHIVE" '$2 == file { print }' SHASUMS256.txt | sha256sum -c -
sudo install -d -m 755 /opt/node22
sudo tar -xJf "$NODE_ARCHIVE" --strip-components=1 -C /opt/node22
sudo ln -sfn /opt/node22/bin/node /usr/local/bin/node
sudo ln -sfn /opt/node22/bin/npm /usr/local/bin/npm
/usr/local/bin/node --version
/usr/local/bin/npm --version
```

### 2.3 安装 Forgejo Runner

以下安装 Runner `13.0.0`。该版本使用模板中的 UUID/Token 注册格式，以 Forgejo 16 为注册配置示例：

```sh
RUNNER_INSTALL_DIR=$(mktemp -d)
cd "$RUNNER_INSTALL_DIR"
case "$(uname -m)" in
    x86_64) RUNNER_ARCH=amd64 ;;
    aarch64|arm64) RUNNER_ARCH=arm64 ;;
    *) echo '不支持的架构'; exit 1 ;;
esac
RUNNER_VERSION=13.0.0
RUNNER_URL="https://code.forgejo.org/forgejo/runner/releases/download/v${RUNNER_VERSION}/forgejo-runner-${RUNNER_VERSION}-linux-${RUNNER_ARCH}"
curl -fSL "$RUNNER_URL" -o forgejo-runner
curl -fSL "${RUNNER_URL}.asc" -o forgejo-runner.asc
gpg --keyserver hkps://keys.openpgp.org --recv-keys EB114F5E6C0DC2BCDD183550A4B61A2DC5923710
gpg --verify forgejo-runner.asc forgejo-runner
```

确认签名验证成功后再安装：

```sh
sudo install -m 755 forgejo-runner /usr/local/bin/forgejo-runner
/usr/local/bin/forgejo-runner --version
```

### 2.4 创建独立用户并安装模板

在 Runner 服务器以管理员身份执行。`forgejo-runner` 用户只运行你自己的配置仓库的任务，不授予 sudo 权限。

```sh
sudo useradd --system --user-group --home-dir /var/lib/forgejo-runner --shell /usr/sbin/nologin forgejo-runner
sudo install -d -o forgejo-runner -g forgejo-runner -m 700 /var/lib/forgejo-runner
sudo install -d -o forgejo-runner -g forgejo-runner -m 700 /var/lib/forgejo-runner/work
sudo install -d -o root -g forgejo-runner -m 750 /etc/forgejo-runner
```

如果这个用户已经存在，跳过 `useradd`。把本仓库克隆到 Runner 服务器，并在仓库根目录执行安装命令：

```sh
git clone https://git.example.com/OWNER/sing-box-config.git
cd sing-box-config
sudo install -o root -g forgejo-runner -m 640 infra/runner/config.example.yml /etc/forgejo-runner/config.yml
sudo install -o root -g root -m 644 infra/runner/forgejo-runner.service /etc/systemd/system/forgejo-runner.service
sudoedit /etc/forgejo-runner/config.yml
```

私有仓库按你现有的 Git 认证方式克隆。仅在首次安装时复制配置模板；不要在升级服务时用模板覆盖已经填写的 UUID 和 Token。

在编辑器里填写第一步得到的 `server.connections.sing-box-config.uuid` 和 `token`。标签保留为：

```yaml
runner:
  labels:
    - sing-box-config:host
```

它对应工作流的 `runs-on: sing-box-config`。任务直接以 `forgejo-runner` 用户执行；项目生成过程只使用 Node.js，发布使用系统 SSH 客户端。

### 2.5 启动服务

先确认服务用户能够找到 Node.js、npm、Git 和 SSH：

```sh
sudo -u forgejo-runner env PATH=/usr/local/bin:/usr/bin:/bin node --version
sudo -u forgejo-runner env PATH=/usr/local/bin:/usr/bin:/bin npm --version
sudo -u forgejo-runner git --version
sudo -u forgejo-runner ssh -V
sudo systemd-analyze verify /etc/systemd/system/forgejo-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now forgejo-runner
sudo systemctl status forgejo-runner --no-pager
sudo journalctl -u forgejo-runner -n 100 --no-pager
```

回到 Forgejo 的 Runner 页面，应能看到在线状态和 `sing-box-config` 标签。Runner 的 `capacity` 是 1，任务依次运行；服务故障自动重启，开机自动启动。工作目录保存在 `/var/lib/forgejo-runner/work`，注册凭据在 `/etc/forgejo-runner/config.yml`。

修改 Runner 配置后执行 `sudo systemctl restart forgejo-runner`。查看实时日志用 `sudo journalctl -u forgejo-runner -f`。不要将实际 Token 提交到仓库。

如果 Runner 一直离线，检查 URL、UUID/Token、服务器时间与证书、出站 DNS/HTTPS。若任务一直排队，检查仓库 Actions 是否启用、Runner 是否属于这个仓库，以及标签是否与 `runs-on` 完全一致。

## 3. 在 Caddy 服务器准备 SSH 发布目录

准备一个能通过专用 SSH 密钥登录的发布账号，以下使用 `sbdeploy`，Caddy 的运行组使用 `caddy`。下面的账号命令适用于 Debian/Ubuntu；如果已经有发布账号，可跳过创建账号。

```sh
sudo adduser --disabled-password --gecos "" sbdeploy
sudo usermod -aG caddy sbdeploy
sudo install -d -o sbdeploy -g caddy -m 2750 /srv/sing-box
```

生成一把仅用于本仓库发布的 Ed25519 密钥（CI 使用不带口令的专用私钥）：

```sh
ssh-keygen -t ed25519 -f ~/.ssh/sing-box-deploy -C forgejo-sing-box-deploy
```

把公钥安装到 Caddy 服务器的 `sbdeploy` 用户 `~/.ssh/authorized_keys`；可以在公钥前加 `restrict`，禁止端口转发等不需要的能力。发布需要执行 SSH 命令和 SFTP/scp，不能给密钥配置 `internal-sftp` 强制命令。登录后的用户应属于 `caddy` 组，并能写入 `/srv/sing-box`。

工作流不需要 root 登录或 sudo。Caddy 服务器需要 `sh`、SFTP/scp、`sha256sum`、`flock` 和 GNU `mv`，常见 Linux 发行版可提供这些工具。

发布目录会采用如下结构：

```text
/srv/sing-box/
├── releases/
│   ├── <旧版本>/
│   └── <新版本>/
│       ├── mac.json
│       ├── ios.json
│       └── SHA256SUMS
└── current -> releases/<新版本>
```

上传失败或文件校验失败不会切换 `current`；所有平台文件全部就绪后在锁内用一次 rename 切换符号链接。旧版本保留，必要时可回退。脚本不会删除旧版本，后续可按你的保留策略清理。

## 4. 在 Forgejo 仓库中配置 Actions Secrets

准备发布时，在仓库设置 → Actions → Variables 中添加 `DEPLOY_ENABLED=true`。仅想测试生成过程时不设置此变量即可。示例地址 `git.example.com`、`config.example.com` 和 `OWNER` 均需替换成你自己的值。

打开仓库设置 → Actions → Secrets，添加：

| Secret | 必填 | 内容 |
| --- | --- | --- |
| `DEPLOY_HOST` | 是 | Caddy 服务器的 SSH 主机名或 IPv4，不含协议、用户名、端口 |
| `DEPLOY_USER` | 是 | SSH 发布用户，例如 `sbdeploy` |
| `DEPLOY_SSH_KEY` | 是 | 专用 SSH 私钥的完整内容，含 BEGIN/END 和换行 |
| `DEPLOY_KNOWN_HOSTS` | 是 | 已核实的 Caddy 服务器 SSH host key 对应的 known_hosts 行 |
| `DEPLOY_PORT` | 否 | SSH 端口，默认 `22` |
| `DEPLOY_PATH` | 否 | 发布根目录，默认 `/srv/sing-box`，不含 `/current` |
| `DEPLOY_GROUP` | 否 | Caddy 的读取组，默认 `caddy`，发布用户必须属于该组 |

获取 host key 时，可用 `ssh-keyscan -p 22 -t ed25519 your-caddy-host` 查看候选行，再和服务器上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的指纹核对。非 22 端口的 known_hosts 主机名应为 `[your-caddy-host]:端口`。不要在每次 CI 运行时重新扫描并直接信任；脚本强制核对已保存的 host key。

这些都是 Forgejo 的 Actions Secrets，不要填到被 Git 跟踪的 JSON、YAML 或 README 中。没有配置 Secrets 时工作流会失败，不会匿名上传配置。

## 5. 配置 Caddy 读取 current 目录

将站点的文件根目录设为 `/srv/sing-box/current`。例如：

```caddyfile
config.example.com {
    basic_auth {
        config-reader 替换为caddy_hash-password生成的哈希
    }

    root * /srv/sing-box/current
    header Cache-Control "no-store"

    @profiles path_regexp profiles ^/[A-Za-z0-9][A-Za-z0-9._-]*[.]json$
    handle @profiles {
        file_server
    }
    handle {
        respond 404
    }
}
```

保留你现有域名及 Basic Auth 设置。如果已有 Caddy 站点使用 `/srv/sing-box`，只需将 root 改为 `/srv/sing-box/current`，外部 URL 不变。第一次发布前 `current` 不存在，下载地址会暂时返回 404。校验并重载 Caddy 后，后续替换文件无需再次重载。

如果 Caddy 使用 Docker，将 `/srv/sing-box` 整个目录只读挂载到容器，root 指向挂载路径下的 `current`；不要只挂载单个符号链接或某个版本目录。`DEPLOY_GROUP` 的组 ID 要能被容器内的 Caddy 进程读取。

## 6. 提交并运行

在本地生成配置并推送：

```sh
npm run build
git add .forgejo ci infra docs lib build.mjs package.json .gitignore README.md
git commit -m "Add Forgejo build and deployment workflow"
git push origin main
```

在 Forgejo 的 Actions 页面查看结果。工作流先生成配置，然后在 `DEPLOY_ENABLED=true` 时发布。构建使用 Node.js，不下载或编译客户端内核。首次启动 Runner 前的 push 如果没有触发工作流，可以在 Actions 页面选择本工作流并手动运行 `main`。

客户端配置 URL 保持为：

- macOS：`https://config.example.com/mac.json`
- iOS：`https://config.example.com/ios.json`

用你实际域名替换示例值，HTTP Basic 的账号密码仍由客户端提供；CI 的 SSH 认证与下载认证相互独立。

## 回退

可以在 Git 中 revert 不想要的配置提交，再 push `main`，重新生成发布。也可以在 Caddy 服务器上把 `current` 原子切换回 `releases/` 下保留的某个版本。不要直接修改 current 目录里的 JSON，否则其校验和会与内容不符。

## 官方参考

- [Forgejo 16 Runner 注册](https://forgejo.org/docs/v16.0/admin/actions/registration/)
- [Runner 二进制与 systemd 安装](https://forgejo.org/docs/latest/admin/actions/installation/binary/)
- [Node.js 22 官方版本](https://nodejs.org/en/download/archive/v22)
- [Runner 标签及配置](https://forgejo.org/docs/latest/admin/actions/configuration/)
- [Forgejo 工作流](https://forgejo.org/docs/latest/user/actions/overview/)
