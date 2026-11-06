from PIL import Image
from pathlib import Path
import shutil,json
root=Path('/home/ubuntu/idvipapp/public/brand');root.mkdir(parents=True,exist_ok=True)
sources=Path('/home/ubuntu/upload')
items=[('dark-ar','واجهةرئيسيةداكنعربي.webp',[0,224,834,1075,1310,1545,1782,2048]),('dark-en','واجهةرئيسيةداكنانجليزيافتراضي.webp',[0,223,833,1075,1309,1543,1769,2048]),('light-ar','واجهةرئيسيةفاتحعربي.webp',[0,240,853,1090,1327,1562,1803,2048]),('light-en','واجهةرئيسيةفاتحانجليزيافتراضي.webp',[0,242,865,1103,1341,1578,1816,2048])]
manifest={}
for key,name,y in items:
 with Image.open(sources/name) as im:
  rows=[('language',(0,y[0],572,y[1])),('theme',(572,y[0],1143,y[1])),('hero',(0,y[1],1143,y[2])),('create',(0,y[2],1143,y[3])),('admin',(0,y[3],1143,y[4])),('search',(0,y[4],1143,y[5])),('terms',(0,y[5],572,y[6])),('privacy',(572,y[5],1143,y[6])),('about',(0,y[6],1143,y[7]))]
  for label,box in rows:
   cropped=im.crop(box)
   cropped.thumbnail((960,960),Image.Resampling.LANCZOS)
   p=root/f'key-{key}-{label}.webp';cropped.save(p,'WEBP',quality=86,method=4,exact=True)
   manifest[p.name]={'source':name,'crop':list(box),'width':cropped.width,'height':cropped.height,'bytes':p.stat().st_size}
 print('Prepared',key,flush=True)
for p in Path('/home/ubuntu/output/idvip/optimized-assets').glob('*.webp'):
 if p.name.startswith(('logo-','cover-')):shutil.copy2(p,root/p.name)
mapping={'work-1.webp':'reference-dark-ar-640.webp','work-2.webp':'reference-light-en-640.webp','work-3.webp':'logo-dark-512.webp','proof-1.webp':'cover-dark-768.webp','proof-2.webp':'cover-light-768.webp','proof-3.webp':'logo-light-512.webp'}
for target,src in mapping.items():shutil.copy2(Path('/home/ubuntu/output/idvip/optimized-assets')/src,root/target)
(root/'key-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print('36 interactive key assets ready')
