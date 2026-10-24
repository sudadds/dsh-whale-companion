"""常驻画面监视器：低分辨率比对，检测到明显变化就在 stdout 打一行 JSON。

用法：python watcher.py [--fps 2] [--threshold 0.22] [--cooldown 6]
输出：{"event":"change","ratio":0.31} —— 每行一条，立即 flush。
"""
import sys, time, json, argparse
from PIL import ImageGrab, ImageChops, ImageStat

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ap = argparse.ArgumentParser()
ap.add_argument('--fps', type=float, default=2.0)
ap.add_argument('--threshold', type=float, default=0.22)
ap.add_argument('--cooldown', type=float, default=6.0)
ap.add_argument('--size', type=int, default=64)
a = ap.parse_args()

interval = 1.0 / max(0.5, a.fps)
SIZE = (a.size, max(8, a.size * 9 // 16))

def grab():
    im = ImageGrab.grab(all_screens=True).convert('L')
    return im.resize(SIZE, 1)  # BILINEAR? 1 = NEAREST 兜底

prev = grab()
last_emit = 0.0
print(json.dumps({'event': 'ready', 'size': SIZE}), flush=True)

while True:
    time.sleep(interval)
    try:
        cur = grab()
    except Exception as e:
        print(json.dumps({'event': 'error', 'message': str(e)}), flush=True)
        time.sleep(2)
        continue
    diff = ImageChops.difference(prev, cur)
    # 用“有多少像素变了”而不是平均亮度：局部剧变（死亡画面、爆炸、过场）才敏感
    hist = diff.histogram()
    changed = sum(hist[16:])          # 灰度差 > 16 的像素数
    total = SIZE[0] * SIZE[1]
    ratio = changed / total
    prev = cur
    now = time.time()
    if ratio >= a.threshold and now - last_emit >= a.cooldown:
        last_emit = now
        print(json.dumps({'event': 'change', 'ratio': round(ratio, 3)}), flush=True)
