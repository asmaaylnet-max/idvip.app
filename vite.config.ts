import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins:[react()], build:{outDir:'dist/client',emptyOutDir:true,manifest:true,rollupOptions:{output:{manualChunks(id){if(id.includes('qrcode'))return 'qr';if(id.includes('simplewebauthn'))return 'passkeys';}}}}, server:{host:'0.0.0.0',port:3000} });
