#!/usr/bin/env python3
"""Render SkyPulse app icons (PNG) with the standard library only.

python pipeline/make_icons.py  ->  LiveWeather/icons/icon-{180,192,512}.png, icon-maskable-512.png, icon.svg
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'LiveWeather', 'icons')


def png(path, w, h, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def render(size, maskable=False, rounded=True):
    ss = 3                                   # 3×3 supersampling for anti-aliasing
    s = 1.0 if not maskable else 0.72        # maskable icons keep content inside the 80% safe zone
    off = (1 - s) / 2
    rad = 0.22 if rounded and not maskable else 0.0
    sun = (off + 0.38 * s, off + 0.36 * s, 0.20 * s)
    clouds = [(off + 0.40 * s, off + 0.64 * s, 0.15 * s), (off + 0.56 * s, off + 0.54 * s, 0.19 * s), (off + 0.73 * s, off + 0.65 * s, 0.13 * s)]
    cloud_rect = (off + 0.40 * s, off + 0.62 * s, off + 0.73 * s, off + 0.78 * s)
    rays = [(math.cos(k * math.pi / 4), math.sin(k * math.pi / 4)) for k in range(8)]
    px = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    u, v = (x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size
                    # background: rounded square with a diagonal gradient
                    if rad:
                        cx, cy = min(max(u, rad), 1 - rad), min(max(v, rad), 1 - rad)
                        if (u - cx) ** 2 + (v - cy) ** 2 > rad * rad:
                            continue
                    t = (u + v) / 2
                    col = (0x3d * (1 - t) + 0x0b * t, 0x8b * (1 - t) + 0x15 * t, 0xfd * (1 - t) + 0x30 * t)
                    du, dv = u - sun[0], v - sun[1]
                    d = math.hypot(du, dv)
                    if d < sun[2] * 1.9:   # glow
                        g = max(0.0, 1 - d / (sun[2] * 1.9)) ** 2 * 0.45
                        col = tuple(c * (1 - g) + o * g for c, o in zip(col, (255, 190, 80)))
                    ray = any(sun[2] * 1.18 < d < sun[2] * 1.55 and abs(du * ry - dv * rx) < 0.022 * s and (du * rx + dv * ry) > 0 for rx, ry in rays)
                    if d < sun[2] or ray:
                        col = (255, 201, 77)
                    in_cloud = any((u - cx) ** 2 + (v - cy) ** 2 < r * r for cx, cy, r in clouds) or (
                        cloud_rect[0] < u < cloud_rect[2] and cloud_rect[1] < v < cloud_rect[3])
                    if in_cloud:
                        shade = 0.9 + 0.1 * (1 - (v - cloud_rect[1]) / (cloud_rect[3] - cloud_rect[1] + 1e-9))
                        col = (238 * shade, 243 * shade, 255 * min(1, shade + 0.04))
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            n = ss * ss
            i = (y * size + x) * 4
            a = acc[3] / n
            if a:
                k = acc[3] / 255
                px[i:i + 4] = bytes([min(255, int(acc[0] / k)), min(255, int(acc[1] / k)), min(255, int(acc[2] / k)), int(a)])
    return px


SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d8bfd"/><stop offset="1" stop-color="#0b1530"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/><circle cx="24" cy="23" r="12.8" fill="#ffc94d"/>
<g fill="#eef3ff"><circle cx="25.6" cy="41" r="9.6"/><circle cx="35.8" cy="34.6" r="12.2"/><circle cx="46.7" cy="41.6" r="8.3"/><rect x="25.6" y="39.7" width="21.1" height="10.2"/></g></svg>'''

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for size, kw, name in ((512, {}, 'icon-512.png'), (192, {}, 'icon-192.png'), (180, {'rounded': False}, 'icon-180.png'),
                           (512, {'maskable': True}, 'icon-maskable-512.png')):
        png(os.path.join(OUT, name), size, size, render(size, **kw))
        print('wrote', name)
    with open(os.path.join(OUT, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(SVG)
