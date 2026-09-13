import zlib, struct, sys

L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011']
G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111']
R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100']
PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL']

def ean13_bits(code):
    assert len(code) == 13 and code.isdigit(), code
    d = [int(c) for c in code]
    bits = '101'
    for i, p in enumerate(PARITY[d[0]]):
        bits += (L if p == 'L' else G)[d[i+1]]
    bits += '01010'
    for i in range(7, 13):
        bits += R[d[i]]
    bits += '101'
    assert len(bits) == 95
    return bits

def render(code, module=4, height=160, quiet=11, path='bar.png'):
    bits = ean13_bits(code)
    w = (len(bits) + 2*quiet) * module
    h = height + 40
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            mi = x // module - quiet
            on = 0 <= mi < len(bits) and bits[mi] == '1' and 20 <= y < 20 + height
            row.append((0,0,0) if on else (255,255,255))
        rows.append(row)
    raw = b''.join(b'\x00' + bytes(v for p in r for v in p) for r in rows)
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    print(f'wrote {path} {w}x{h} for {code}')

render('0737628064502', path='test-barcode.png')
