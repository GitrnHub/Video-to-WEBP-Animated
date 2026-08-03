#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将视频转换为循环播放的 WebP 动图。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CONFIG_NAME = "value.json"


class WebperError(RuntimeError):
    """可直接展示给用户的错误。"""


@dataclass(frozen=True)
class Config:
    ffmpeg_path: str
    max_input_size_mb: float
    fps: float
    max_edge: int
    allow_upscale: bool
    quality: float
    compression_level: int
    lossless: bool
    loop: int
    fps_round: str
    pixel_format: str
    scale_algorithm: str
    overwrite_output: bool
    extra_ffmpeg_args: tuple[str, ...]

    @property
    def max_input_size_bytes(self) -> int:
        return int(self.max_input_size_mb * 1024 * 1024)


def app_dir() -> Path:
    """返回脚本或 PyInstaller 打包后 exe 所在目录。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _require(data: dict[str, Any], key: str, expected: type) -> Any:
    if key not in data:
        raise WebperError(f'{CONFIG_NAME} 缺少字段 "{key}"。')
    value = data[key]
    if expected is float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise WebperError(f'{CONFIG_NAME} 字段 "{key}" 必须是数字。')
        return float(value)
    if expected is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise WebperError(f'{CONFIG_NAME} 字段 "{key}" 必须是整数。')
        return value
    if not isinstance(value, expected):
        raise WebperError(
            f'{CONFIG_NAME} 字段 "{key}" 必须是 {expected.__name__} 类型。'
        )
    return value


def load_config(config_file: Path) -> Config:
    if not config_file.is_file():
        raise WebperError(f"未找到配置文件：{config_file}")

    try:
        data = json.loads(config_file.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise WebperError(f"无法读取 {CONFIG_NAME}：{exc}") from exc
    except json.JSONDecodeError as exc:
        raise WebperError(
            f"{CONFIG_NAME} 格式错误：第 {exc.lineno} 行，第 {exc.colno} 列：{exc.msg}"
        ) from exc

    if not isinstance(data, dict):
        raise WebperError(f"{CONFIG_NAME} 顶层必须是 JSON 对象。")

    ffmpeg_path = _require(data, "ffmpeg_path", str).strip()
    max_input_size_mb = _require(data, "max_input_size_mb", float)
    fps = _require(data, "fps", float)
    max_edge = _require(data, "max_edge", int)
    allow_upscale = _require(data, "allow_upscale", bool)
    quality = _require(data, "quality", float)
    compression_level = _require(data, "compression_level", int)
    lossless = _require(data, "lossless", bool)
    loop = _require(data, "loop", int)
    fps_round = _require(data, "fps_round", str).strip()
    pixel_format = _require(data, "pixel_format", str).strip()
    scale_algorithm = _require(data, "scale_algorithm", str).strip().lower()
    overwrite_output = _require(data, "overwrite_output", bool)

    extra = data.get("extra_ffmpeg_args", [])
    if not isinstance(extra, list) or not all(isinstance(item, str) for item in extra):
        raise WebperError(
            f'{CONFIG_NAME} 字段 "extra_ffmpeg_args" 必须是字符串数组。'
        )

    if not ffmpeg_path:
        raise WebperError(f'{CONFIG_NAME} 字段 "ffmpeg_path" 不能为空。')
    if max_input_size_mb <= 0:
        raise WebperError(f'{CONFIG_NAME} 字段 "max_input_size_mb" 必须大于 0。')
    if not 0 < fps <= 240:
        raise WebperError(f'{CONFIG_NAME} 字段 "fps" 必须在 0 到 240 之间。')
    if not 2 <= max_edge <= 16384:
        raise WebperError(f'{CONFIG_NAME} 字段 "max_edge" 必须在 2 到 16384 之间。')
    if not 0 <= quality <= 100:
        raise WebperError(f'{CONFIG_NAME} 字段 "quality" 必须在 0 到 100 之间。')
    if not 0 <= compression_level <= 6:
        raise WebperError(
            f'{CONFIG_NAME} 字段 "compression_level" 必须在 0 到 6 之间。'
        )
    if loop < 0:
        raise WebperError(f'{CONFIG_NAME} 字段 "loop" 不能小于 0。')

    valid_rounding = {"zero", "inf", "down", "up", "near"}
    if fps_round not in valid_rounding:
        choices = ", ".join(sorted(valid_rounding))
        raise WebperError(
            f'{CONFIG_NAME} 字段 "fps_round" 必须是以下之一：{choices}。'
        )
    if not pixel_format:
        raise WebperError(f'{CONFIG_NAME} 字段 "pixel_format" 不能为空。')

    valid_scale_algorithms = {
        "fast_bilinear",
        "bilinear",
        "bicubic",
        "neighbor",
        "area",
        "gauss",
        "sinc",
        "lanczos",
        "spline",
    }
    if scale_algorithm not in valid_scale_algorithms:
        choices = ", ".join(sorted(valid_scale_algorithms))
        raise WebperError(
            f'{CONFIG_NAME} 字段 "scale_algorithm" 必须是以下之一：{choices}。'
        )

    return Config(
        ffmpeg_path=ffmpeg_path,
        max_input_size_mb=max_input_size_mb,
        fps=fps,
        max_edge=max_edge,
        allow_upscale=allow_upscale,
        quality=quality,
        compression_level=compression_level,
        lossless=lossless,
        loop=loop,
        fps_round=fps_round,
        pixel_format=pixel_format,
        scale_algorithm=scale_algorithm,
        overwrite_output=overwrite_output,
        extra_ffmpeg_args=tuple(extra),
    )


def ffmpeg_executable(ffmpeg_dir: Path) -> Path | None:
    """兼容 FFmpeg/bin/ffmpeg.exe 与 FFmpeg/ffmpeg.exe 两种布局。"""
    candidates = (
        ffmpeg_dir / "bin" / "ffmpeg.exe",
        ffmpeg_dir / "ffmpeg.exe",
    )
    return next((path for path in candidates if path.is_file()), None)


def locate_ffmpeg(base: Path, configured_path: str) -> Path:
    """优先使用程序同目录的 FFmpeg，失效时读取配置中的备用路径。"""
    local_dir = base / "FFmpeg"
    local_exe = ffmpeg_executable(local_dir)
    if local_exe:
        return local_exe

    expanded = os.path.expandvars(configured_path)
    backup_path = Path(expanded).expanduser()
    if not backup_path.is_absolute():
        backup_path = base / backup_path

    if backup_path.is_file() and backup_path.name.lower() == "ffmpeg.exe":
        backup_exe = backup_path
    else:
        backup_exe = ffmpeg_executable(backup_path)

    if backup_exe:
        return backup_exe

    checked = [
        local_dir / "bin" / "ffmpeg.exe",
        local_dir / "ffmpeg.exe",
    ]
    if backup_path.suffix.lower() == ".exe":
        checked.append(backup_path)
    else:
        checked.extend(
            (
                backup_path / "bin" / "ffmpeg.exe",
                backup_path / "ffmpeg.exe",
            )
        )

    checked_text = "\n".join(f"  - {path}" for path in checked)
    raise WebperError(
        "找不到可用的 ffmpeg.exe。已检查：\n"
        f"{checked_text}\n"
        f"请放置同目录 FFmpeg 文件夹，或修改 {base / CONFIG_NAME}。"
    )


def get_input_path(config: Config) -> Path:
    raw = sys.argv[1] if len(sys.argv) > 1 else input("拖入视频文件：\n> ")
    raw = raw.strip().strip('"')
    if not raw:
        raise WebperError("未提供视频文件。")

    path = Path(raw).expanduser()
    if not path.is_file():
        raise WebperError(f"文件不存在：{path}")

    file_size = path.stat().st_size
    if file_size > config.max_input_size_bytes:
        actual_mb = file_size / 1024 / 1024
        raise WebperError(
            f"输入文件为 {actual_mb:.2f} MiB，超过配置限制 "
            f"{config.max_input_size_mb:g} MiB。"
        )
    return path.resolve()


def output_path_for(input_path: Path) -> Path:
    output = input_path.with_suffix(".webp")
    if output == input_path:
        output = input_path.with_name(f"{input_path.stem}_converted.webp")
    return output


def _number_text(value: float) -> str:
    return f"{value:g}"


def build_filter(config: Config) -> str:
    """构建单次解码、缩放、帧率转换和像素格式转换滤镜。"""
    edge = config.max_edge
    if config.allow_upscale:
        scale_width = str(edge)
        scale_height = str(edge)
    else:
        scale_width = f"min(iw\\,{edge})"
        scale_height = f"min(ih\\,{edge})"

    return ",".join(
        (
            f"fps={_number_text(config.fps)}:round={config.fps_round}",
            (
                f"scale=w='{scale_width}':h='{scale_height}':"
                "force_original_aspect_ratio=decrease:"
                "force_divisible_by=2:"
                f"flags={config.scale_algorithm}"
            ),
            "setsar=1/1",
            f"format=pix_fmts={config.pixel_format}",
        )
    )


def temporary_output(final_output: Path) -> Path:
    return final_output.with_name(
        f".{final_output.stem}.{os.getpid()}.tmp.webp"
    )


def convert(
    ffmpeg: Path,
    input_path: Path,
    output_path: Path,
    config: Config,
) -> None:
    if output_path.exists() and not config.overwrite_output:
        raise WebperError(
            f"输出文件已存在：{output_path}\n"
            f'如需覆盖，请把 {CONFIG_NAME} 中的 "overwrite_output" 改为 true。'
        )

    temp_output = temporary_output(output_path)
    temp_output.unlink(missing_ok=True)

    command = [
        str(ffmpeg),
        "-hide_banner",
        "-y",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        build_filter(config),
        "-fps_mode",
        "passthrough",
        "-c:v",
        "libwebp_anim",
        "-lossless",
        "1" if config.lossless else "0",
        "-quality",
        _number_text(config.quality),
        "-compression_level",
        str(config.compression_level),
        "-loop",
        str(config.loop),
        *config.extra_ffmpeg_args,
        "-f",
        "webp",
        str(temp_output),
    ]

    print(f"配置：{app_dir() / CONFIG_NAME}")
    print(f"FFmpeg：{ffmpeg}")
    print(f"输入：{input_path}")
    print(f"输出：{output_path}")
    print("命令：")
    print(subprocess.list2cmdline(command))
    print()

    try:
        result = subprocess.run(command, check=False)
    except OSError as exc:
        temp_output.unlink(missing_ok=True)
        raise WebperError(f"无法启动 FFmpeg：{exc}") from exc
    except KeyboardInterrupt as exc:
        temp_output.unlink(missing_ok=True)
        raise WebperError("用户已取消转换。") from exc

    if result.returncode != 0:
        temp_output.unlink(missing_ok=True)
        raise WebperError(f"FFmpeg 转换失败，退出码：{result.returncode}")

    if not temp_output.is_file() or temp_output.stat().st_size == 0:
        temp_output.unlink(missing_ok=True)
        raise WebperError("FFmpeg 未生成有效的 WebP 文件。")

    try:
        if output_path.exists() and config.overwrite_output:
            output_path.unlink()
        temp_output.replace(output_path)
    except OSError as exc:
        temp_output.unlink(missing_ok=True)
        raise WebperError(f"无法保存输出文件：{exc}") from exc


def pause_after_error() -> None:
    """双击或拖放到 Windows exe 时，避免错误窗口瞬间关闭。"""
    is_packaged = getattr(sys, "frozen", False) or getattr(
        sys, "_webper_embedded", False
    )
    if os.name == "nt" and is_packaged:
        try:
            input("\n按 Enter 键退出……")
        except EOFError:
            pass


def main() -> int:
    try:
        base = app_dir()
        config = load_config(base / CONFIG_NAME)
        ffmpeg = locate_ffmpeg(base, config.ffmpeg_path)
        input_path = get_input_path(config)
        output_path = output_path_for(input_path)
        convert(ffmpeg, input_path, output_path, config)
        print(f"\n转换完成：{output_path}")
        return 0
    except WebperError as exc:
        print(f"\n错误：{exc}", file=sys.stderr)
        pause_after_error()
        return 1
    except Exception:
        import traceback

        print("\n发生未预期错误：", file=sys.stderr)
        traceback.print_exc()
        pause_after_error()
        return 1


if __name__ == "__main__":
    exit_code = main()
    if getattr(sys, "_webper_embedded", False):
        os.environ["WEBPER_EXIT_CODE"] = str(exit_code)
    else:
        raise SystemExit(exit_code)
