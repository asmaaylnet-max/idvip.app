from pathlib import Path
import hashlib,mimetypes,base64,json,sys
root=Path('/home/ubuntu/idvipapp')
assets=root/'dist/client'
worker=(root/'dist/worker/worker-public.js')
if len(sys.argv)>1:worker=root/sys.argv[1]
manifest={};files={}
for p in sorted(assets.rglob('*')):
 if not p.is_file() or '/.vite/' in str(p):continue
 raw=p.read_bytes();h=hashlib.sha256(raw).hexdigest()[:32]
 mime=mimetypes.guess_type(p.name)[0] or 'application/octet-stream'
 if p.suffix=='.webmanifest':mime='application/manifest+json'
 if p.suffix=='.js':mime='application/javascript'
 if p.suffix=='.woff2':mime='font/woff2'
 manifest['/'+str(p.relative_to(assets))]={'hash':h,'size':len(raw)}
 files[h]={'base64':base64.b64encode(raw).decode(),'mime':mime}
out={'manifest':manifest,'files':files,'worker':worker.read_text(),'phase':sys.argv[2] if len(sys.argv)>2 else '1'}
p=root/'dist/deploy-packet.json';p.write_text(json.dumps(out,separators=(',',':'))+'\n')
print('Public deployment packet',len(manifest),'assets',p.stat().st_size,'bytes; no application secrets included.')
