# 流存 StreamSave

本地运行的视频批量下载工具。批量导入视频链接，统一管理并发、保存目录、文件名称和编号。页面使用 hls.js 预览视频，Node.js 服务调用 FFmpeg 将视频流合并并写入本机文件夹。

- 批量粘贴链接，导入 TXT / CSV，导出 CSV 任务清单。
- 同时下载 1 至 8 个任务，支持暂停、继续和失败重试。
- 选择保存目录，按名称、编号和自定义模板整理文件。
- 保存 MP4、MKV 或 TS，完成后预览视频或在文件夹中显示。

## 启动

需要 Node.js 22 以上，以及 `ffmpeg`、`ffprobe`。macOS 可以使用 Homebrew 安装 FFmpeg：

```sh
brew install ffmpeg
```

克隆项目后安装依赖并启动：

```sh
git clone https://github.com/g-dxw/streamsave.git
cd streamsave
npm ci
npm start
```

打开 <http://127.0.0.1:4173>。服务只监听本机，不开放到局域网。

默认保存位置为项目内的 `downloads/`；可在页面输入其他绝对路径，或使用 macOS 原生文件夹选择器。网页关闭后，运行中的本地服务仍会继续下载。

## 使用

1. 每行粘贴一个视频地址，或导入 TXT、CSV。支持 `视频名称 | https://...`，CSV 支持 `name,url` 或 `url,name` 表头。
2. 设置同时下载任务数（1 至 8）、本地目录、MP4 / MKV / TS 格式、文件名模板、起始编号和编号位数。
3. 添加到队列，点击「开始下载」。任务可以暂停、继续、失败重试，或单独修改名称和编号。

命名规则支持 `{number}` 和 `{name}`，例如 `第{number}课_{name}`。编号随批次自动递增，同名文件会添加后缀，不覆盖原文件。已完成的任务可预览视频或在文件夹中显示。导出的 CSV 清单可以重新导入。

请求来源校验可在高级设置填写 Referer 和 User Agent。浏览器预览受视频源跨域策略限制；本地下载不受浏览器跨域限制。

## 保存和暂停

- 设置和任务记录保存在 `.data/state.json`，只在本机保存。
- macOS / Linux 服务持续运行时，暂停会暂停对应 FFmpeg 进程，继续可从当前进度恢复。
- 服务重启后保留记录，未完成任务恢复为暂停，继续时从头下载；不承诺跨进程断点续传。
- 格式转换使用流复制，不重新压制视频；源编码必须兼容所选容器，不兼容时可改用 MKV。
- 当前面向有限时长的点播内容，持续直播流和 DRM 视频不支持。检测到缺失分片时不会把不完整视频标为成功。
- 清理完成记录不会删除已保存的视频。移除未完成任务会清理其临时文件。
- 未在 Windows 验证暂停和目录选择；当前主要验证环境为 macOS。

## 本地 hls.js

仓库已包含可直接运行的 hls.js 构建产物。需要重新构建时，将 hls.js 源码放在本项目的同级目录：

```text
workspace/
├── hls.js/
└── streamsave/
```

```sh
npm run build
```

构建使用 `../hls.js` 的真实源代码，写入 `public/vendor/hls.js`，不修改原仓库。其他位置可设置 `HLS_SOURCE_DIR` 再构建：

```sh
HLS_SOURCE_DIR=/path/to/hls.js npm run build
```

源码版本和构建信息记录在 `public/vendor/hls-source.json`。第三方组件与授权文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

配置 `PORT` 可以更换端口，`FFMPEG_PATH`、`FFPROBE_PATH` 可以指定可执行文件路径。

## 验证

```sh
npm run check
npm test
```

测试会生成短 HLS 视频，并通过临时本机服务验证真实下载、文件保护、并发、暂停继续、重试、请求头、缺失分片报错以及任务恢复。临时文件在测试后清理。页面验证记录见 `docs/validation.md`。

## 本地数据

任务、视频、测试输出、环境配置和依赖目录均在 `.gitignore` 中排除，不随源码上传。仓库提供的是本地应用，GitHub 仓库地址不是可在线运行的下载服务。
