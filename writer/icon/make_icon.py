# 生成简记 App 图标：绿色底 + 白色纸页 + 分级缩进的条目线
import os, sys
from PIL import Image, ImageDraw
BG = (61, 107, 92); BG2 = (52, 94, 80)
PAGE = (251, 250, 246); LINE = (61, 107, 92); LINE_SOFT = (170, 196, 186)
S = 1024

def glyph(size):
    """在 size×size 透明画布中央画纸页（自适应图标的前景，内容在中间安全区内）"""
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    u = size / 108.0                       # 1dp
    pl, pt, pr, pb = 33*u, 29*u, 75*u, 79*u  # 纸页
    # 阴影
    d.rounded_rectangle((pl+1.2*u, pt+1.8*u, pr+1.2*u, pb+1.8*u), radius=5*u, fill=(0, 0, 0, 45))
    d.rounded_rectangle((pl, pt, pr, pb), radius=5*u, fill=PAGE)
    rows = [(0, 1.0), (1, 0.85), (2, 0.7), (1, 0.8)]   # (层级, 线长比例)
    y = pt + 10*u
    for lv, frac in rows:
        x = pl + 7*u + lv*6*u
        r = 2.1*u
        d.ellipse((x-r, y-r, x+r, y+r), fill=LINE if lv == 0 else LINE_SOFT if lv == 2 else LINE)
        x2 = x + 5*u + (pr - 7*u - (x + 5*u)) * frac
        h = 2.6*u if lv == 0 else 2.0*u
        d.rounded_rectangle((x + 5*u, y - h/2, x2, y + h/2), radius=h/2, fill=LINE if lv == 0 else (120, 156, 143))
        y += 10.5*u
    return im

def background(size, shape):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    # 轻微上下渐变
    grad = Image.new('RGBA', (size, size))
    gd = ImageDraw.Draw(grad)
    for i in range(size):
        t = i / size
        gd.line((0, i, size, i), fill=tuple(int(BG[k]*(1-t) + BG2[k]*t) for k in range(3)) + (255,))
    mask = Image.new('L', (size, size), 0); md = ImageDraw.Draw(mask)
    if shape == 'round': md.ellipse((0, 0, size-1, size-1), fill=255)
    else: md.rounded_rectangle((0, 0, size-1, size-1), radius=size*0.22, fill=255)
    im.paste(grad, (0, 0), mask)
    return im

def legacy(shape):
    # 旧式图标：整个图标占画布，前景按 108dp 等比缩放到 48dp 画布外框里
    big = background(S, shape)
    g = glyph(int(S * 108 / 72))   # 自适应图标可见区域约为中间 72dp
    off = (S - g.width) // 2
    big.alpha_composite(g, (off, off))
    return big

out = sys.argv[1]
dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
fg = glyph(S * 2); sq = legacy('square'); rd = legacy('round')
for k, m in dens.items():
    p = os.path.join(out, 'mipmap-' + k); os.makedirs(p, exist_ok=True)
    fg.resize((int(108*m),)*2, Image.LANCZOS).save(os.path.join(p, 'ic_launcher_foreground.png'))
    sq.resize((int(48*m),)*2, Image.LANCZOS).save(os.path.join(p, 'ic_launcher.png'))
    rd.resize((int(48*m),)*2, Image.LANCZOS).save(os.path.join(p, 'ic_launcher_round.png'))
os.makedirs(os.path.join(out, 'values'), exist_ok=True)
open(os.path.join(out, 'values', 'ic_launcher_background.xml'), 'w').write(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#3D6B5C</color>\n</resources>\n')
# 预览图
prev = Image.new('RGB', (1100, 380), (236, 236, 232))
prev.paste(sq.resize((300, 300), Image.LANCZOS), (40, 40), sq.resize((300, 300), Image.LANCZOS))
prev.paste(rd.resize((300, 300), Image.LANCZOS), (400, 40), rd.resize((300, 300), Image.LANCZOS))
small = sq.resize((96, 96), Image.LANCZOS); prev.paste(small, (800, 140), small)
small = sq.resize((48, 48), Image.LANCZOS); prev.paste(small, (940, 164), small)
prev.save(os.path.join(out, '..', 'preview.png'))
