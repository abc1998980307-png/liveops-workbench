# 安装工作台组件

适用：macOS Apple Silicon、Python 3.9+。需要先安装 Apple 命令行工具（终端运行 `xcode-select --install` 并完成系统安装界面），以及 [Google Chrome](https://www.google.com/chrome/)。安装器不会自动接受系统许可或修改系统 Python。

## 网页安装

从仓库运行 `python3 server.py`，打开 `http://127.0.0.1:8765/#settings`。在“本机组件安装”中点击“安装缺少的组件”，可查看进度和错误日志。浏览器可以切换页面，安装继续执行。只在本机工作台接收安装请求；网页不能指定任意命令、下载地址或文件目录。

首次会安装专用 Node.js、Playwright Core、FFmpeg、bililive-go、CMake、Whisper CLI、small-q5_1 多语言模型和 DailyHotApi。下载数百 MB，建议至少留出 2 GB 临时空间。默认下载限速 1 MiB/s，Whisper 使用两个构建任务。安装不启动录制器、不添加直播间、不启动账号采集、不更改现有录屏后处理设置。

“已找到”表示指定目录存在文件，不等于平台账号已经登录或业务接口可访问。安装器会执行工具检查，正式连接仍在录制器卡片和经营数据页面完成。**Ego 和其他第三方平台不包含在此安装器中**（KeyBERT 提供下述独立安装入口），其安装 / 运行流程仍在路线图中。

## 命令行安装

```sh
python3 scripts/install.py
python3 scripts/install.py --apply
python3 scripts/doctor.py --full
python3 server.py
```

第一条只预览，不创建文件。默认安装目录为 `~/Library/Application Support/LiveOps/`。已有目录检查通过则跳过；检查失败则停止并保留原状，不覆盖或升级正在使用的工具。失败后修正原因再运行相同命令，已校验的下载缓存会复用。网络中断或校验失败不会发布半成品。

组件可按需选择，例如 `--components node,collector`，或 `--components ffmpeg,recorder`。`whisper` 自动包含 `cmake`，`model` 自动包含 `whisper,cmake`。`--cache /绝对路径` 指定缓存，`--rate-kib 1024` 设置下载限速。

程序优先使用显式的 `LIVEOPS_NODE` / `LIVEOPS_PLAYWRIGHT_MODULE`；随后查找正常环境与工作台专用目录；旧 Codex 运行时只作兼容回退。新安装不依赖 Codex 的私有运行时。

## 固定来源与版本

下载地址和 SHA-256 在 `scripts/dependencies.json` 中维护，不使用浮动 latest。Node 校验值来自官方 SHASUMS256，FFmpeg/CMake 来自 PyPI 元数据，bililive-go 来自 GitHub 发布资源摘要，模型来自 Hugging Face LFS 对象摘要。Whisper 固定在 v1.9.5 对应提交 `d1be6fde11ac6e0407606b4e42fe72d34add8037`，源码包摘要由该官方提交归档计算。Playwright 使用项目 package-lock.json 的精确版本和包完整性记录。

| 工具 | 固定版本 | 来源 |
|---|---|---|
| Node.js | 24.22.2 | nodejs.org |
| Playwright Core | 1.62.1 | npm 官方注册表 |
| FFmpeg | 7.1，imageio-ffmpeg 0.6.0 arm64 wheel | PyPI / imageio |
| bililive-go | 0.8.3 | bililive-go 官方 GitHub |
| CMake | 3.31.6 universal2 wheel | PyPI / CMake |
| Whisper CLI | 1.9.5 固定提交，静态库并内嵌 Metal 资源 | ggml-org 官方 GitHub |
| Whisper 模型 | small-q5_1 | ggerganov/whisper.cpp |
| DailyHotApi | 2.0.8，固定提交 36c77e3bd891c11642d314cfb229bf31646704de | imsyy 官方 GitHub；npm 完整性锁文件 |

下载与解包先在临时目录进行，拒绝路径越界、链接逃逸、特殊文件及超限包；只有校验和可执行检查通过才发布目录。源码及许可证保留在本机工具目录，二进制、模型和缓存不提交到 GitHub。

## 独立目录验收

以下流程用于开发检查或第二台 Mac 验收。使用尚无业务文件的独立目录，不能指向日常工作台目录。

```sh
python3 scripts/install.py --apply --data-root /tmp/liveops-install-check
python3 scripts/verify_install.py --data-root /tmp/liveops-install-check
```

验证器检查依赖，启动零直播间的录制器，使用 macOS 合成语音生成测试 FLV，再完成压缩、严格全片解码、删除合成原件、生成 TXT/SRT。随后使用独立端口启动网页与空采集器，检查健康接口、HTML 与账号列表，以及不请求上游榜单的热点服务启动，并关闭自己启动的服务。验收报告在独立目录的 `logs/install/verification.json`。它不会登录罗盘或写入飞书，也不证明真实业务指标准确或长直播无断流。

`LIVEOPS_DATA_ROOT` 可统一设置网页、录制管理、媒体处理及采集默认数据目录；必须为绝对路径。不要在运行中切换已有工作台的目录。使用独立目录直接运行网页时也应通过 `LIVEOPS_PORT`、`LIVEOPS_BGO_URL` 和 `LIVEOPS_HOT_API_URL` 配置独立端口，避免连接到日常服务。

2026-11-09：本机独立目录安装、二次运行幂等、空录制器启动 / 停止、真实 FFmpeg / Whisper 合成媒体闭环、网页 / 空采集器检查通过；网页安装按钮与 390px 布局验证通过。**第二台物理 Mac、全新系统前置工具安装、中文语音准确性仍未由这次验收证明。**

## KeyBERT 中文关键词

热词洞察 → 本机转写语料关键词 → 安装 KeyBERT 与中文模型。需要 macOS Apple Silicon 与 Python 3.9—3.11；不修改系统 Python。首次下载多语言模型约 480 MB，Python 包与模型合计需要约 2 GB 空间。

```sh
python3 scripts/install_keywords.py
python3 scripts/install_keywords.py --apply
# 也可使用独立目录做安装验收
python3 scripts/install_keywords.py --apply --data-root /tmp/liveops-keyword-check
```

包版本及 PyPI SHA-256 记录在 `scripts/requirements-keywords.lock`；构建工具单独引导，模型固定提交和文件 SHA-256 记录在 `scripts/keyword-model.json`。安装会验证本地模型实际编码中文文本。已有环境检查失败时保留原目录，查看日志后移走失效目录再重试。取消或下载失败不会覆盖已有模型；已校验下载缓存可复用。

安装完点击“分析语料”。分析是本机后台任务，保留上次结果并显示时间；关闭网页不影响运行，停止工作台会结束任务，重新打开后可重试。分析阶段只读取本机模型，不访问网络。来源为 `transcripts/`，TXT/SRT 同份内容不重复计数；有字数 / 文件数上限，界面会报告部分结果。

结果和日志位于本机 `keywords/`，Python 环境在 `tools/keywords-env`，模型在 `tools/keyword-model`；这些运行文件不提交到 GitHub。

## 热点榜安装与运行

“数据源接入 → DailyHotApi → 管理热点服务”进入运行设置的热点服务卡片，也可直接在运行设置中操作。依次点击“安装热点组件”“启动”“读取榜单”；“检查状态”只访问本机健康接口，不请求抖音。支持停止及重启并应用设置，安装失败可看日志后重试。

命令行可使用 `python3 scripts/install.py --components dailyhot --apply`，自动包含专用 Node.js。源码包固定提交和 SHA-256，npm 依赖按 `scripts/dailyhot-package-lock.json` 安装并检查完整性，不运行依赖安装脚本；TypeScript 构建后才发布安装目录。

热点服务只监听 127.0.0.1，设置保存到 `plugin-settings/dailyhot.env`，兼容读取旧服务目录的 `.env`。保存设置与重启分开：卡片会比对当前实际配置，提示是否待重启。服务健康和上游榜单可用性分开显示；自动刷新尊重缓存时间。上游超时、接口变化或网络问题不会被误标成服务进程已停止。

工作台只停止自己启动且身份仍匹配的进程，网页服务重启后可恢复管理。已有其他工具启动的 DailyHotApi 可继续读榜，停止 / 重启须在原工具操作。服务手动停止后不自动重启；电脑重启后通过网页再次启动。该服务不使用罗盘或千川账号。

2026-11-09：本机独立目录完成源码校验、锁定依赖安装、构建、重复安装、真实 50 条榜单与缓存命中；网页启动、停止、保存 / 重启配置验证通过。另一台物理 Mac 仍未实测。
