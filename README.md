# Video-to-WEBP-Animated

图片与视频转 WebP 工具；仓库只保留 WebP 转换器本身，DXR / WebGPU 实验已拆分到独立仓库。

**在线版：** https://gitrnhub.github.io/Video-to-WEBP-Animated/

## 在线版功能

- 图片自动转换为**静态 WebP**；
- 视频自动转换为**WebP 动图**；
- 根据文件类型自动切换设置：图片显示无损选项，视频显示帧率和循环选项；
- 图片默认使用浏览器原生 WebP 编码，视频与无损图片使用 FFmpeg WebAssembly；
- 兼容手机、平板和电脑；
- 支持画质、最长边、帧率、循环次数、压缩级别等设置；
- 默认限制输入文件不超过 50 MiB。

## 目录

```text
├── docs/                 GitHub Pages 在线版
├── desktop/              Python + 原生 FFmpeg 桌面脚本
│   ├── webper.py
│   └── value.json
├── README.md
├── THIRD_PARTY_NOTICES.md
└── LICENSE
```

## 处理逻辑

- 普通图片：Canvas / 浏览器原生 WebP 编码器，输出单帧静态 WebP；
- 无损图片：FFmpeg WebAssembly + `libwebp`，输出单帧静态 WebP；
- 视频：FFmpeg WebAssembly + `libwebp_anim`，输出循环 WebP 动图，固定使用有损模式。

首次进行视频或无损图片转换时，浏览器需要加载 FFmpeg WebAssembly 核心。浏览器版通常比本机原生 FFmpeg 慢；移动设备、长视频、高分辨率或高帧率任务可能耗时较长并占用更多内存。

## 桌面版

`desktop/webper.py` 保留原 Python 脚本，需要本机 Python 和原生 FFmpeg，并按照 `desktop/value.json` 读取配置。

## 相关实验仓库

- **DXR Lab:** https://github.com/GitrnHub/DXR-lab
- **Web Openworld / OfficeWalk3D:** https://github.com/GitrnHub/Web-Openworld

这样 DXR 云编译、WebGPU 漫游实验与 WebP 工具互不混杂，各自的 Actions / Pages / 文档也更容易维护。
