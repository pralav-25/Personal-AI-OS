# 单机首次部署

0.0.1 服务端以公开源码和 Compose 发布。服务器本地构建镜像；此版本不提供 GHCR 镜像。
0.0.1 不提供预编译客户端。手机、Mac、手表和眼镜均需从源码构建，并按各工程的构建说明另行取得供应商 SDK 和模型。

## 主机与网络

使用 Linux、Docker Engine、Buildx 和 Docker Compose 2.36 或更新版本。不要使用只有 `docker-compose` v1 的环境。
建议至少 4 vCPU、8 GiB 内存、80 GiB 可用磁盘；本地构建建议 16 GiB 内存。容量是部署预算，实际占用随依赖、媒体和模型增长。
构建需要访问容器镜像仓库、Debian APT、npm、PyPI、GitHub 和 Google Android 仓库。宿主只需 Docker 工具链；准备镜像提供 Node、Python、Git 和 OpenSSL。
构建代理使用进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`（也支持小写名称）。启动命令将它们传入构建和准备容器。Docker 客户端保持默认、不自动注入运行代理的配置；运行时的模型代理按服务单独配置。本地 RTC 信令需要直连。

默认 `localhost` 供本机验证。远程客户端需要把 `PAIOS_PUBLIC_HOST` 改为可达的 DNS 名或 IPv4，把 `PAIOS_PUBLIC_IPV4` 改为该主机地址。
放行 TCP 8443（HTTPS/WSS）、TCP 7881 和 UDP 7882（实时媒体）。TURN 默认关闭；启用时按 `.env` 中的端口和 relay 范围放行。
数据库、Hermes、个人集成和工坊不需要公网端口。

## 从公开源码启动

在公开仓库根目录执行：

```sh
cp deploy/cloud/.env.example deploy/cloud/.env
chmod 600 deploy/cloud/.env
# 编辑 .env，填写 PAIOS_BRAIN_API_KEY。
# 示例中的 brain model/base URL 可替换为自己的 OpenAI-compatible Chat Completions 服务。
sh deploy/cloud/build.sh --up
```

执行用户必须能访问 Docker daemon。准备容器会在工作树内创建 `deploy/cloud/.build`、`deploy/cloud/.local/secrets` 和 `deploy/cloud/.local/tls`；公开仓库的 `.gitignore` 已排除这些目录。
准备容器以 root 运行，只把新生成的运行文件交给容器 UID 10000。不要把这些目录加入 Git。

该命令构建既有 Gateway、Hermes、Front 和工坊镜像，然后启动数据库、运行迁移、创建实例身份，最后启动七个核心服务。
核心默认支持文字对话。默认配置不要求本地声纹、音频和视觉模型，不连接云手机、Mac 中继、冷存储、数字人或预发。
实例身份与客户端身份分别由现有策略存储和配对数据库维护。启动不会创建一个虚构的已配对设备。

检查状态：

```sh
cd deploy/cloud
docker compose --env-file .env --env-file .build/production.public.env \
  -f compose.yaml -f compose.single-host.yaml ps
```

首次启动会生成数据库密码、内部 API 凭据、LiveKit 凭据、E2EE、付款和声纹密钥。
生成器保留已有密钥的原字节。模型密钥写入 `role-*.key`；重启时这些文件是密钥来源。
更换 `.env` 的密钥不会覆盖旧文件；轮换时需明确更新相应文件，并保持 UID 10000、权限 600，再重启服务。
不要删除 secrets 来解决启动错误。实例身份、配对记录和加密数据需要这些凭据。

## TLS

没有证书时，准备器为配置的 host/IP 生成带 SAN 的自签证书。默认有效期为 365 天。
将 `.local/tls/fullchain.pem` 导入客户端信任，或在首次启动前把自己的证书与私钥放入同名路径。
证书和私钥必须同时存在；准备器不替换已有证书。正式公网客户端建议使用可信证书。
已有 `deploy/cloud/acme/` 提供域名证书获取和续期；它还需要自己的 DNS、域名验证及 ACME 配置。
自签证书不等于已完成各 Apple 或 Android 客户端的系统信任配置。

## 配对与模拟文字对话

真实客户端先按对应客户端说明构建，导出注册文件。把注册文件放入实例数据卷后，使用现有工具配对：

```sh
# 在 deploy/cloud 目录，可在当前 shell 定义一次，后面的命令复用它。
compose() { docker compose --env-file .env --env-file .build/production.public.env \
  -f compose.yaml -f compose.single-host.yaml "$@"; }
compose exec gateway node \
  01-product-half-finished/backend/phase0/gateway/tools/mac-product-provision.ts pair \
  --root /var/lib/paios --config /etc/paios/cloud.json \
  --registration /var/lib/paios/resources/client-registration.json
compose restart gateway
compose up -d --no-deps --wait --wait-timeout 240 gateway
```

配对输出会指出配对文件位置。配对文件含客户端凭据，只交给对应客户端。

无设备验收可用仓库现有模拟客户端。先在 Gateway 内创建一次真实 X25519 注册资料，私钥留在数据卷：

```sh
compose exec -T gateway node --input-type=module <<'JS'
import {generateKeyPairSync, createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const pair = generateKeyPairSync('x25519');
const publicKey = pair.publicKey.export({format:'jwk'}).x;
const root = '/var/lib/paios/resources/';
writeFileSync(root+'sim-recipient.jwk', JSON.stringify(pair.privateKey.export({format:'jwk'})), {mode:0o600,flag:'wx'});
writeFileSync(root+'client-registration.json', JSON.stringify({public_raw32_base64url:publicKey,
  public_sha256:createHash('sha256').update(Buffer.from(publicKey,'base64url')).digest('hex'),
  label:'Local simulated client'}), {mode:0o600,flag:'wx'});
JS
```

再执行上面的 `pair` 和 `restart`。以下 Linux 命令让模拟客户端使用宿主网络访问发布端口；项目名和镜像名与示例 `.env` 一致：

```sh
docker run --rm --network host --user 0:0 \
  -e HOME=/home/paios \
  -e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/paios-local.crt \
  -v personal-ai-os_owner-data:/var/lib/paios \
  -v "$PWD/.local/tls:/run/tls:ro" \
  --entrypoint sh paios-gateway:0.0.1 -ec '
    cp /run/tls/fullchain.pem /usr/local/share/ca-certificates/paios-local.crt
    chmod 644 /usr/local/share/ca-certificates/paios-local.crt
    update-ca-certificates > /dev/null
    exec setpriv --reuid=10000 --regid=10000 --clear-groups node \
      01-product-half-finished/backend/phase0/gateway/tools/mac-product-sim-client.ts "$@"' sim-client \
  --pairing /var/lib/paios/resources/iphone-pairing.v1.json \
  --recipient-key /var/lib/paios/resources/sim-recipient.jwk \
  --text-only --prompt '请用一句话介绍你可以怎样帮助我。'
```

此命令只在临时客户端容器内安装证书信任，随后以 UID 10000 运行客户端，不改宿主系统信任。
检查模拟客户端输出中的文字接收与确认结果。容器 healthy 只说明相应健康检查通过；文字往返还需要模型实际返回内容。
模拟客户端的音视频能力不代表真实设备的权限、麦克风、扬声器和网络已验收。
Mac 桌面模拟器的 scratch 范围、参数、PDF 前置条件和清理方法见 [Mac 桌面模拟器指南](desktop-simulator.md)。

## 模型角色

`.env.example` 为每个角色分别列出 `MODEL`、`BASE_URL` 和 `API_KEY`。可让多个角色使用同一提供商。

| 角色前缀 | 用途 | 默认 |
|---|---|---|
| `PAIOS_BRAIN` | 主脑及对话推理 | 必填；示例使用 DeepSeek 官方 API |
| `PAIOS_VISION` | Hermes 视觉辅助 | 关闭 |
| `PAIOS_EXECUTOR_FAST` | 手机执行器快速档 | 关闭；启用手机时配置 |
| `PAIOS_EXECUTOR_THOROUGH` | 手机执行器深入档 | 关闭；启用手机时配置 |
| `PAIOS_REALTIME` | 实时语音前端 | 关闭；还需 VOICE 及现有本地音频模型 |
| `PAIOS_TTS` | 合成语音 | 关闭；还需 VOICE，并依赖 realtime 配置 |
| `PAIOS_WORKSHOP_REPAIR` | 工坊修复模型 | 关闭；未设置时工坊使用已配置 brain |

Realtime 和 TTS 使用现有 DashScope-compatible WebSocket 协议；它们不是任意 Chat Completions 服务。
语音路径的本地 VAD、ASR、说话人、关键词及音频标签模型，仍按 `cloud.json` 中的路径和摘要安装到 `models` 卷。
此单机文字启动命令不自动安装这些模型，也不声称语音路径已经验收。

## 可选组件

更改配置后重新执行 `build.sh --up`。依赖账号、登录和资源必须先准备好。

| 开关 | 前置条件 |
|---|---|
| `PAIOS_ENABLE_PHONE=1` | 设置 `PAIOS_PHONE_PROVIDER=agentbay`、镜像、agentbay key、ADB key，并配置 executor 两个角色；使用受支持的账号登录流程 |
| `PAIOS_ENABLE_OWNER_MAC=1` | 按 `prepare-owner-mac.py` 和客户端流程生成中继配置、绑定 Mac；中继与 visitor 使用同一开关 |
| `PAIOS_ENABLE_EDGE=1` | 配置 frpc 对端和令牌；直接公网部署不需要它 |
| `PAIOS_ENABLE_COLD_STORAGE=1` | 配置 OpenList/WebDAV、初始化目录及独立访问凭据；AliyunDrive 由 OpenList 挂载 |
| `PAIOS_ENABLE_AVATAR=1` | 在 `cloud.json` 中配置自己的 Vidu 形象、动作库和模型，并设置 `vidu.key`；公开默认配置不含其他实例的资源 ID |
| `PAIOS_ENABLE_AMAP=1` | 提供自己的 `amap.key` |
| `PAIOS_ENABLE_MIHOME=1` | 提供米家登录资料和对应设备授权 |
| `PAIOS_ENABLE_WECHAT=1` | 启用现有 Mac 微信技能；要求 `PAIOS_ENABLE_OWNER_MAC=1`、已登录的 Mac 微信和发送授权。关闭后 Hermes 不列出或加载该技能；通用 Mac 工具仍按自身授权工作 |
| `PAIOS_ENABLE_SELF_REPAIR` | 单机命令不接受设为 1；见下段 |

0.0.1 单机入口不启用预发与自动自修复发布。现有发布链还需要独立预发数据、候选源码仓库、远程 builder 凭据、主机 release runner/systemd 单元、快照与回滚配置。
只启动工坊不满足自动发布条件。`deploy/` 的受保护变更仍必须经过正式发布流程。

## 停止、备份与回退

在 `deploy/cloud` 使用上述 `compose` 函数执行 `compose --profile '*' down`，停止该项目已启用的核心及可选服务；不加 `-v`，保留数据卷。
同时备份 `.local/secrets`、`.local/tls`、数据库、实例数据卷和工坊数据。先在隔离目录验证恢复。
本地构建的旧镜像可保留并在 `.env` 中切换显式标签。镜像回退不自动撤销数据库迁移、客户端变更或外部操作。
