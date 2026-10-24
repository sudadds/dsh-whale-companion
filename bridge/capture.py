"""抓前台窗口（没有可用窗口就抓全屏），缩到 1280 宽，打印 JSON：{file,title,w,h,full}。"""
import ctypes, ctypes.wintypes as wt, json, sys
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass
from PIL import ImageGrab

out = sys.argv[1] if len(sys.argv) > 1 else 'frame.jpg'
max_w = int(sys.argv[2]) if len(sys.argv) > 2 else 1280

u = ctypes.windll.user32
hwnd = u.GetForegroundWindow()
title = ''
box = None
try:
    n = u.GetWindowTextLengthW(hwnd)
    if n > 0:
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value.strip()
    r = wt.RECT()
    if u.GetWindowRect(hwnd, ctypes.byref(r)):
        w, h = r.right - r.left, r.bottom - r.top
        # 太小 / 标题是我们自己 → 不裁
        if w > 400 and h > 300 and 'whale overlay' not in title.lower():
            box = (r.left, r.top, r.right, r.bottom)
except Exception:
    pass

img = ImageGrab.grab(bbox=box, all_screens=True) if box else ImageGrab.grab(all_screens=True)
img = img.convert('RGB')
w, h = img.size
if w > max_w:
    img = img.resize((max_w, int(h * max_w / w)), 2)
img.save(out, 'JPEG', quality=75, optimize=True)
print(json.dumps({'file': out, 'title': title, 'w': img.size[0], 'h': img.size[1], 'cropped': bool(box)}, ensure_ascii=False))
