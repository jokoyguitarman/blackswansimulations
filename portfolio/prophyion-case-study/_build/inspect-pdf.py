import fitz, sys, os
here = os.path.dirname(os.path.abspath(__file__))
pdf = os.path.join(here, '..', 'Prophyion_AI_Agents_Case_Study.pdf')
doc = fitz.open(pdf)
print('pages', doc.page_count)
os.makedirs(os.path.join(here, 'qa'), exist_ok=True)
for i, p in enumerate(doc):
    pix = p.get_pixmap(dpi=150)
    pix.save(os.path.join(here, 'qa', f'qa_p{i+1}.png'))
    sizes = {}
    for b in p.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                sizes[round(s['size'], 1)] = sizes.get(round(s['size'], 1), 0) + len(s['text'])
    print(i + 1, 'min font', min(sizes), sorted(sizes.items())[:4])
fonts = set()
for p in doc:
    for f in p.get_fonts():
        fonts.add(f[3])
print(fonts)
