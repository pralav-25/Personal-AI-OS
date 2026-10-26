# Tests from the public checkout · 公开仓库测试

Personal-AI-OS lets people self-host their own personal assistant, Yimi (依米). Tests should show which part of that experience works. Public CI checks local contracts and synthetic behavior. It needs no model credentials, real account, user data, device or Apple toolchain. A passing public suite does not establish production or real-device acceptance.

先按 [first-run.md](first-run.md)准备开发环境。以下命令都从公开仓库根目录执行，除非明确说明进入包目录。使用 Node **24.19.0**、Python **3.12**；产品支持范围以各包的声明为准。安装系统的 `ffmpeg`，确认同一目录中还有 `ffprobe`。快照加密测试还需要 `age` 和 `age-keygen`。安装脚本会为 Python 媒体测试准备 Pillow、NumPy 和 headless OpenCV。Linux 的中文图像夹具使用 `fonts-wqy-zenhei`，可将 `PAIOS_TEST_CJK_FONT` 指向该字体文件。

## Reproduce public CI

```sh
bash ci/install.sh gateway
PAIOS_DEMUX_TOOLCHAIN="$(dirname "$(command -v ffmpeg)")" python3 ci/public-tests.py gateway
PAIOS_DEMUX_TOOLCHAIN="$(dirname "$(command -v ffmpeg)")" python3 ci/public-tests.py integration
python3 ci/public-tests.py hermes
bash ci/install.sh executor
python3 ci/public-tests.py executor
```

`ci/install.sh gateway` installs the shared Node test prerequisites and an isolated Hermes test environment. `integration` and `hermes` accept the same setup arguments when used separately. Setup rebuilds Hermes from `producer.lock.json` plus `native-context.patch` through the existing `verify-producer.mjs`; it never uses an installed personal profile. The executor uses its own hash-locked Python environment. Its payment fixtures also start the real Integration Node bridge, so executor setup installs Integration, Platform Data and Qwen Embedded from their existing lockfiles. Dependencies come from public package registries and the pinned upstream repository. Installation is allowed network access; test model calls use local stubs.

The media prerequisites use NumPy 2.0.2 and the compatible OpenCV 5.0 patch series. The installation log records the wheel version resolved for the platform. FFmpeg must provide FLAC encoding for the lossless PCM archive tests; a minimal decoding-only build is insufficient.

The current native OpenAI client imports Bedrock support during initialization. Setup installs the upstream `bedrock` extra with `dev`, so the isolated producer does not try to install that dependency while serving the local model stub.

The runner keeps Node's native module compile cache in `.scratch/node-compile-cache` for reuse between test processes. Git discovery stops at this checkout, so an exported tree cannot accidentally borrow a parent repository's history. Assertions and test timeouts remain the package's own.

脚本在 `.scratch/` 中重建固定的 Hermes，并创建独立 Python 环境。不会借用某台机器已安装的个人 profile。executor 单独安装其哈希锁定依赖。安装会访问公开仓库与包注册表；测试无需模型密钥。已有的重建目录会先通过原来的 producer 检查。切换 producer 锁后，请另建一个干净开发副本重新安装。

For one touched test, run its existing runner in its package directory. The broad CI selector is not required for a focused local check:

```sh
cd 01-product-half-finished/backend/services/personal-aios-integration
node --test tests/activity.test.ts
```

For a native Python or cross-runtime case, first use the environment paths assigned in `ci/public-tests.py`: the rebuilt source, the Hermes interpreter and the isolated test home must belong to this checkout. Its `test_environment()` function supplies that same environment for a focused process. Do not point it at a live profile. Run the selected test with `.scratch/hermes-venv/bin/python -m pytest -q -p no:cacheprovider tests/hermes/test_effect_gate.py` from the root, with `PYTHONPATH` set to `.scratch/hermes-source`.

## Package commands

These are the package's actual test entrypoints. Optional database, model and platform tests retain their prerequisite gates. Context Engine, Connector Runtime and Realtime Core share Gateway's development tools for **typechecking**. Integration declares its own TypeScript and Node types; that does not change the test commands below.

| Package / 目录（backend 内为相对路径） | Command after dependencies are installed / 测试命令 |
| --- | --- |
| `phase0/gateway` | `npm test` in that package; use the public CI selector above when required fixtures are absent. |
| `services/personal-aios-integration` | `npm test` in that package; same prerequisite selector rule. |
| `services/connector-runtime` | `npm test` in that package. |
| `services/context-engine` | `npm test` in that package; runs `backend/tests/context/activity-acceptance.test.ts`. |
| `services/memory-os` | Install its `pnpm-lock.yaml` dependencies with pnpm 11.9.0, then `npm test` in that package. |
| `services/public-rtc` | `npm test` in that package. |
| `services/realtime-core` | `npm test` in that package. |
| `services/platform-data` | Install its `pnpm-lock.yaml` dependencies. Use `node --test --experimental-strip-types tests/*.test.ts` in that package; PostgreSQL cases require an isolated disposable database and their documented environment variables. `npm run test:pg` selects the database cases. Never use a production database. |
| `services/qwen-embedded` | No package test script is declared. Gateway's embedded-voice contract tests cover the consumer. Do not report a nonexistent test script as a passing suite. |
| Hermes product plugin | Root: `python3 ci/public-tests.py hermes`; targeted tests use `pytest` as above. |
| Phone executor | Root: `python3 ci/public-tests.py executor`; direct package command is its environment's `python -m unittest discover -p 'test_*.py'`. |
| Cloud preparation | `python3 -m unittest discover -s deploy/cloud -p 'test_*.py'` from the root, using the prerequisites in first-run. This is not a container-start acceptance. |

## What CI omits and why

Run `python3 ci/public-tests.py list` for the exact versioned inventory. The runner prints each explicit omission before execution. Node omissions match exact test names and leave other tests in the same file enabled. Some tests need deployment profiles, application sources, audio assets or producer provenance not included in this repository. Four named functions in `test_cloud_init.py` need such external fixtures; the other cloud-init tests still run. Runtime contract documents are included: a missing runtime input is a failure.

Six compatibility comparisons need predecessor Git objects outside this repository: three Integration comparisons, one Hermes endpoint comparison and two single-test executor modules (`test_payment_privacy` and `test_payment_release_equality`). Public CI omits those comparisons. Current payment, voiceprint, deployment, archive and reset tests still run. Test processes do not search parent repositories for missing history.

Other cases state their own prerequisites: disposable PostgreSQL, separately licensed speech/KWS/model assets, macOS `say` and frameworks, LiveKit credentials or Linux root/namespace capabilities. Public CI does not supply model assets, account credentials or privileged containers. Read the test totals and skip reasons. An omitted or skipped test did not pass. Run additional prerequisites only in an isolated environment, and keep real personal data and secrets out of contributions.

运行 `python3 ci/public-tests.py list` 可查看逐项省略清单。部分测试依赖本仓库未包含的部署配置、应用源码、音频资料或历史 Git 对象；省略按精确名称执行，同文件其他测试继续运行。当前版本的支付、声纹、部署、归档和重置测试仍执行。数据库、模型、平台和权限前提由各用例明确说明。公开 CI 不提供真实账号或特权容器，不把省略或跳过算成通过。补充验收应使用隔离环境，不把真实资料或秘密带进贡献。

## Client checks outside Linux CI

The canonical client root is `01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native`. From the repository root:

```sh
apple=01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native
app="$apple/PersonalAIOSPhase0/OpenSource/apple-health-exporter/app"
swift test --package-path "$app"
swift test --package-path "$apple/YimiDesktop/DesktopKit"
swift test --package-path "$apple/VoiceWake"
```

VoiceWake needs its separately acquired runtime/model resources. The vendor `AliyunARTC` package is a binary dependency wrapper and declares no test target. After acquiring the vendor SDKs described in first-run, the iPhone and Watch build commands run inside `$app`:

```sh
xcodebuild -project HealthKitExporter.xcodeproj -scheme HealthKitExporter \
  -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO build
xcodebuild -project HealthKitExporter.xcodeproj -scheme PersonalAIOSWatch \
  -destination generic/platform=watchOS CODE_SIGNING_ALLOWED=NO build
```

The iPhone RTC dependency has no simulator slice. A simulator build cannot replace the generic-device build. The Mac app builds from `YimiDesktop/YimiDesktop.xcodeproj` with scheme `YimiDesktop` and destination `platform=macOS`. Android glasses use `gradle -p 01-product-half-finished/glasses-android :app:testDebugUnitTest :app:assembleDebug --max-workers=2` after the documented Android and vendor dependencies are present. No signed client binaries are promised by these commands. Device behavior still needs separate authorized acceptance.

## Public tree scan

The `Public tree scan` CI job runs `python3 tools/oss-scan/scan.py --public --root .` against the checked-out PR tree, using the shared scanner and gitleaks. It does not export again, read a private secret directory or require a repository secret. Keep scanner policy changes reviewable. A release also requires credential-leak checks, license and asset review, and the deployment checks described in first-run.

The workflow uses GitHub-hosted Linux runners, a read-only repository token, no persisted checkout credentials and full commit pins for actions. Fork PRs do not receive project credentials. It does not publish images or packages.
