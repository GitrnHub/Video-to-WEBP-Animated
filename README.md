# Video-to-WEBP-Animated

基于浏览器的图片 / 视频转 WebP 工具，同时保留原有 Python + 原生 FFmpeg 桌面脚本。

## 在线版功能

- 图片自动转换为**静态 WebP**；
- 视频自动转换为**WebP 动图**；
- 图片默认使用浏览器原生 WebP 编码，启动快；
- 视频与无损图片使用 FFmpeg WebAssembly；
- 文件只在浏览器本地处理，不上传服务器；
- 兼容手机、平板和电脑，自适应 1080p、2K、4K 屏幕；
- 支持质量、最长边、帧率、循环次数、压缩级别等设置；
- 默认限制输入文件不超过 50 MiB。

## 目录

```text
├── docs/                 GitHub Pages 在线版（直接发布）
├── desktop/              原有 Python 桌面脚本
│   ├── webper.py
│   └── value.json
├── README.md
├── THIRD_PARTY_NOTICES.md
└── UPLOAD_INSTRUCTIONS.txt
```

## 发布到 GitHub Pages

当前仓库已经配置为从 `main` 分支的 `/docs` 目录发布。将本压缩包解压后，把**压缩包内部的全部文件和文件夹**上传到仓库根目录并提交即可。GitHub Pages 会自动重新部署。

不要只上传 ZIP 文件；GitHub Pages 不会自动解压 ZIP。

## 处理逻辑

- 普通图片：Canvas / 浏览器原生 WebP 编码器，输出单帧静态 WebP；
- 无损图片：FFmpeg WebAssembly + `libwebp`，输出单帧静态 WebP；
- 视频：FFmpeg WebAssembly + `libwebp_anim`，输出循环 WebP 动图。

首次进行视频或无损图片转换时，浏览器会从 CDN 下载约 31 MiB 的 FFmpeg 核心。之后通常可使用浏览器缓存。

## 桌面版

`desktop/webper.py` 保留了原脚本。它需要本机 Python 和原生 FFmpeg，并按照 `desktop/value.json` 读取配置。

## 说明

浏览器中的 WebAssembly 版本通常比本机原生 FFmpeg 慢。移动设备、长视频、高分辨率或高帧率任务可能耗时较长并占用较多内存。
