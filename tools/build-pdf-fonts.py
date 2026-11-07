#!/usr/bin/env python3
"""Собирает pdf-fonts.js — подмножества шрифтов для экспорта КП в PDF.

Шрифты (SIL OFL): Inter (текст и таблицы) и Lora Bold (заголовки, итоговая сумма).
Берём только латиницу, кириллицу и нужную пунктуацию (+ «₽», «№»),
у Inter цифры подменяются на табличные (ровные колонки сумм),
CFF-контуры Inter переводятся в TrueType (для встраивания в PDF).

Использование:
  pip install fonttools
  python tools/build-pdf-fonts.py --inter DIR_WITH_INTER_OTF --lora Lora-Variable.ttf
"""
import argparse, base64, io, json, os
from fontTools.ttLib import TTFont, newTable
from fontTools import subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.varLib import instancer

RANGES = [(0x20, 0x7E), (0xA0, 0xFF), (0x100, 0x17F), (0x400, 0x4FF),
          (0x2010, 0x2015), (0x2018, 0x201E), (0x2020, 0x2022), (0x2026, 0x2026),
          (0x2030, 0x2030), (0x2116, 0x2116), (0x20AC, 0x20AC), (0x20BD, 0x20BD),
          (0x2212, 0x2212), (0x2248, 0x2248), (0x2260, 0x2260), (0x2264, 0x2265)]
UNICODES = [c for a, b in RANGES for c in range(a, b + 1)]


def tabular_digits(font):
    names = set(font.getGlyphOrder())
    for cp in range(0x30, 0x3A):
        base = font.getBestCmap()[cp]
        if base + '.tf' in names:
            for t in font['cmap'].tables:
                if cp in t.cmap:
                    t.cmap[cp] = base + '.tf'


def do_subset(font):
    opts = subset.Options()
    opts.layout_features = []
    opts.hinting = False
    opts.notdef_outline = True
    opts.name_IDs = [1, 2, 3, 4, 6]
    opts.glyph_names = False
    opts.drop_tables += ['GSUB', 'GPOS', 'GDEF', 'STAT', 'DSIG', 'kern', 'MATH']
    s = subset.Subsetter(opts)
    s.populate(unicodes=UNICODES)
    s.subset(font)


def otf_to_ttf(font, max_err=1.0):
    order = font.getGlyphOrder()
    gs = font.getGlyphSet()
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(gs)
        gs[name].draw(Cu2QuPen(pen, max_err, reverse_direction=True))
        glyphs[name] = pen.glyph()
    font['loca'] = newTable('loca')
    font['glyf'] = glyf = newTable('glyf')
    glyf.glyphOrder = order
    glyf.glyphs = glyphs
    del font['CFF ']
    if 'VORG' in font:
        del font['VORG']
    glyf.compile(font)
    hmtx = font['hmtx']
    for name in order:
        g = glyf[name]
        adv, _ = hmtx[name]
        hmtx[name] = (adv, getattr(g, 'xMin', 0))
    font['maxp'] = maxp = newTable('maxp')
    maxp.tableVersion = 0x00010000
    maxp.numGlyphs = len(order)
    for a in ('maxZones', 'maxTwilightPoints', 'maxStorage', 'maxFunctionDefs',
              'maxInstructionDefs', 'maxStackElements', 'maxSizeOfInstructions',
              'maxComponentElements'):
        setattr(maxp, a, 0)
    maxp.maxZones = 1
    maxp.maxPoints = maxp.maxContours = maxp.maxCompositePoints = 0
    maxp.maxCompositeContours = maxp.maxComponentDepth = 0
    font['head'].indexToLocFormat = 0
    font['post'].formatType = 3.0
    font.sfntVersion = '\x00\x01\x00\x00'
    maxp.recalc(font)


def to_b64(font):
    buf = io.BytesIO()
    font.save(buf)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--inter', required=True, help='папка с Inter-Regular.otf и Inter-Bold.otf')
    ap.add_argument('--lora', required=True, help='Lora-Variable.ttf')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'pdf-fonts.js'))
    a = ap.parse_args()
    out = {}
    for key, fn in (('sans', 'Inter-Regular.otf'), ('sansBold', 'Inter-SemiBold.otf')):
        f = TTFont(os.path.join(a.inter, fn))
        tabular_digits(f)
        do_subset(f)
        otf_to_ttf(f)
        out[key] = to_b64(f)
    f = TTFont(a.lora)
    f = instancer.instantiateVariableFont(f, {'wght': 700}, inplace=False)
    do_subset(f)
    out['serifBold'] = to_b64(f)
    with open(a.out, 'w', encoding='utf-8') as fh:
        fh.write('/* Сгенерировано tools/build-pdf-fonts.py. Inter и Lora — SIL Open Font License 1.1. */\n')
        fh.write('(typeof self!=="undefined"?self:globalThis).MasterokPdfFonts=' + json.dumps(out) + ';\n')
    for k, v in out.items():
        print(k, round(len(v) * 3 / 4 / 1024), 'KB')


main()
