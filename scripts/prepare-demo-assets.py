from pathlib import Path
from PIL import Image
import json
root=Path(__file__).resolve().parents[1]
source=Image.open('/home/ubuntu/upload/غلافداكن.webp').convert('RGB')
w,h=source.size
# Regions are normalized to the supplied panoramic illustration. These are
# demonstration illustrations, not a user's certificates or portfolio evidence.
boxes={
 'work-1':(.500,.340,.665,.760),
 'work-2':(.419,.428,.510,.747),
 'work-3':(.339,.437,.419,.738),
 'proof-1':(.689,.443,.760,.730),
 'proof-2':(.634,.534,.680,.747),
 'proof-3':(.045,.076,.310,.817),
}
out=[]
for name,box in boxes.items():
 crop=source.crop(tuple(round(v*(w if i%2==0 else h)) for i,v in enumerate(box)))
 crop.thumbnail((560,560),Image.Resampling.LANCZOS)
 target=root/'public'/'brand'/f'{name}.webp'
 crop.save(target,'WEBP',quality=78,method=6)
 with Image.open(target) as check:
  check.load()
  assert check.format=='WEBP' and check.size==crop.size
 out.append({'name':name,'width':crop.width,'height':crop.height,'bytes':target.stat().st_size,'source':'owner-supplied-cover','illustrative':True})
(root/'docs'/'demo-asset-manifest.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(out,ensure_ascii=False))
