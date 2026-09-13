import zlib, struct

BG   = (26, 26, 24)      # --ink
BAR  = (250, 250, 247)   # --paper
MARK = (61, 122, 69)     # --green

# Barcode-ish bar pattern (width units), alternating bar/gap
PATTERN = [3,2,1,1,2,3,1,2,1,3,1,1,2,2,1,3,2,1,1,2]

def make(size, safe=0.72):
    px = [[BG for _ in range(size)] for _ in range(size)]

    # Bars occupy the central safe area so the icon survives maskable cropping.
    box = size * safe
    x0 = (size - box) / 2
    y0 = (size - box) / 2
    total = sum(PATTERN)
    unit = box / total
    bar_top = y0 + box * 0.10
    bar_bot = y0 + box * 0.74

    x = x0
    for i, w in enumerate(PATTERN):
        if i % 2 == 0:  # draw only the bars, skip the gaps
            for yy in range(int(bar_top), int(bar_bot)):
                for xx in range(int(x), int(x + w * unit)):
                    if 0 <= xx < size and 0 <= yy < size:
                        px[yy][xx] = BAR
        x += w * unit

    # A green underline reads as the "tracked" accent at small sizes.
    ul_top = int(y0 + box * 0.84)
    ul_bot = int(y0 + box * 0.96)
    for yy in range(ul_top, ul_bot):
        for xx in range(int(x0), int(x0 + box)):
            if 0 <= xx < size and 0 <= yy < size:
                px[yy][xx] = MARK

    raw = b''.join(b'\x00' + bytes(v for p in row for v in p) for row in px)
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))

for size, name in [(180,'icon-180.png'), (192,'icon-192.png'), (512,'icon-512.png')]:
    open(f'public/{name}','wb').write(make(size))
    print('wrote', name, size)
