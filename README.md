# 直播操盘台 · LiveOps Workbench

本机运行的直播经营工作台，将直播监控、录屏后处理、罗盘经营数据、热点榜和飞书多维表格同步集中到网页中。

**当前版本是持续开发基线，尚未完成全部功能与真实业务验收。** 开发范围、优先级和逐项验收见 [功能路线图](docs/ROADMAP.md) 与 [技术架构](docs/ARCHITECTURE.md)。

## 当前能力

- 直播账号管理，粘贴抖音主页链接后可自动检测开播并交给 bililive-go 监测 / 录制；支持录制器控制和录屏列表。
- 录屏完成后压缩，验证成功后按设置删除对应原文件，保留压缩视频；可用 whisper.cpp 生成 TXT / SRT。
- 后处理支持失败重试及服务重启后继续；可单独恢复 FLV 最后一个 H.264 残包。恢复操作保留损坏原件，生成视频仍须严格校验，不补回断流画面。
- 场次页支持本地字幕搜索、片段内时间码、查看字幕、搜索结果 CSV 导出和 Finder 文件定位；视频已移走时仍可查找保留的字幕。
- 长录制场次显示录制器场次、当前片段时长与文件切换记录；记录保存在本机，网络故障不会被误判为下播。录制器确认结束后可合并已校验片段；历史片段可能缺失，尚未关联经营场次。
- 场次复盘可按录制场次保存摘要与后续行动，重新打开并导出 Markdown；可手动确认录制场次与本机已保存的罗盘场次对应关系，并显示快照来源、采样时间、指标原值与单位。生产罗盘库尚无已保存场次，真实经营复盘未验收。
- 罗盘独立账号登录、今日场次检测、8 项核心指标、商品数据、本机趋势和 JSON 导出。
- 可手动逐页读取罗盘近 90 天历史场次目录，按账号和精确场次 ID 去重、保存续读进度；历史目录不生成指标快照，也不进入飞书同步。
- 飞书多维表格配置、按账号和场次更新、去重、失败重试；本机应用和目标表已授权，真实经营记录写入仍待有数据场次验收。
- DailyHotApi 热点榜、筛选和导出；网页安装、启动、停止、重启、配置生效检查和日志，区分服务健康与上游榜单可用性。
- 热词洞察可分析本机已生成的 TXT / SRT 转写语料，按本地相关度列出关键词、出现次数和字幕出处，并导出 CSV；该结果与热点热度、搜索量、成交指标分开计算。
- Ego 后台接入的最近核验记录。Ego 浏览器辅助操作与定时 Chrome 采集是不同连接方式。

千川消耗已有真实历史单场核验，但自动消耗采集和历史批量导入仍需恢复广告账户选择；经营复盘仍需真实场次闭环。关键词分析使用本机 KeyBERT 与固定版本多语言模型，需在热词洞察页安装组件。

## 运行方式

当前完整运行环境为 **macOS Apple Silicon**。Python 核心服务只使用标准库；罗盘采集需要 Node.js 24+、Google Chrome 和 Playwright Core。录制、压缩、转写和热点榜分别依赖额外的本机服务。

```sh
git clone https://github.com/abc1998980307-png/liveops-workbench.git
cd liveops-workbench
python3 scripts/install.py --apply
python3 scripts/doctor.py --full
python3 server.py
```

在浏览器访问 <http://127.0.0.1:8765/#business>。Python 需要 3.9+，Whisper 源码构建需要 Apple 命令行工具；Google Chrome 需从官网安装。也可以先启动网页，再在“运行设置 → 本机组件安装”中安装。详细步骤和验证范围见 [安装说明](docs/INSTALLATION.md)。开发环境仍可运行 `npm ci` 安装项目依赖。

日常可以双击 `启动直播操盘台.command`。该启动器优先打开已经运行的服务；如本机存在旧的 `LiveOps/dashboard` 安装副本，也会优先使用安装副本。开发新版本时直接运行仓库的 `server.py`，并先正常停止占用 8765 端口的旧服务；有录制或媒体后处理时等待结束。

运行数据位于 `~/Library/Application Support/LiveOps/`，与 Git 仓库分开。安装器提供采集、录制、压缩和离线转写组件；KeyBERT 在热词洞察单独安装（Python 3.9—3.11）。DailyHotApi 已纳入安装器，也可在运行设置中单独安装和管理；其他第三方平台接入仍待补齐。账号配置见 [运行和连接说明](rpa/README.md)。

## 测试

```sh
python3 scripts/install.py --components ffmpeg --apply
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/check_frontend.py
```

GitHub Actions 在推送和 Pull Request 时运行这些检查，并在独立临时数据目录安装已锁定版本和哈希的 FFmpeg，以实际验证合成视频合并后的音频、容器时长和完整解码。测试使用合成数据或临时目录，不扫码、不录制真实直播、不写入真实飞书表格。真实业务验收单独记录。

## 项目结构

| 路径 | 用途 |
|---|---|
| `直播操盘台.html`、`*-ui.js/css` | 六个工作台页面及连接 UI |
| `server.py` | 本机 HTTP API、静态文件和服务适配 |
| `rpa/`、`rpa_bridge.py` | 浏览器采集、SQLite 存储、飞书同步 |
| `recorder_service.py`、`recording_sessions.py` | 录制器进程、配置及场次观察记录 |
| `session_reviews.py` | 本机录制场次复盘的保存、读取与 Markdown 导出 |
| `session_links.py` | 用户确认的录制场次与罗盘经营场次关联；账号身份变化时隐藏指标 |
| `media_pipeline.py`、`flv_recovery.py` | 压缩、校验、转写、恢复重试及源文件清理 |
| `scripts/` | 环境检查和开发检查 |
| `tests/` | 自动测试 |
| `docs/` | 范围、进度、验收和交接 |

## GitHub 与跨电脑使用

GitHub 保存源码、文档、测试与版本历史。完整交付清单在 [Issue #1](https://github.com/abc1998980307-png/liveops-workbench/issues/1)，逐项验收标准见 [docs/ROADMAP.md](docs/ROADMAP.md)。它不会运行本机录制器，也不会自动同步浏览器登录态或业务数据库。其他电脑需要取得仓库、安装依赖并重新登录自己的后台；GitHub Pages 不能运行本项目的 Python/Node 后端。

本仓库只包含自行实现的工作台代码与文档，不包含第三方程序包、逆向原始脚本、账号会话、密钥、录屏、转写内容和真实经营数据。维护方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

长直播录制及断流限制见 [录制诊断记录](docs/RECORDING_DIAGNOSTICS.md)，开发变更见 [变更记录](docs/CHANGELOG.md)。
