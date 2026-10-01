# Meta AI Image Generator

Generate gambar dari Meta AI menggunakan Chrome profile milik project, lalu upscale semua hasil otomatis.

## Persiapan

1. Install Node.js LTS: https://nodejs.org/en/download
2. Install Google Chrome.
   Bila memakai Edge, set `META_AI_BROWSER_CHANNEL=msedge` sebelum menjalankan script.
3. Buka terminal di folder project.
4. Jalankan:

```bash
npm install
```

Windows tidak butuh ImageMagick. Dependency `sharp` otomatis mengonversi hasil Meta AI ke JPEG saat download.

## Login pertama kali

```bash
node generator.mjs --login
```

Login Meta AI di Chrome yang terbuka. Setelah selesai, tutup browser. Session tersimpan di `browser-profile/`.

Jangan hapus folder itu, kalau tidak ingin login ulang.

## Jalankan

Mac:

```bash
./run-mac.command
```

Windows:

```bat
run-windows.bat
```

Atau langsung:

```bash
node generator.mjs
```

## Perintah lain

```bash
node generator.mjs --dry-run
node generator.mjs --check
node generator.mjs 1
node generator.mjs 1 3
node generator.mjs --upscale-only
```

## Config

Edit `image-prompt.json`.

Bagian upscale:

```json
"upscale": {
  "enabled": true,
  "scale": 4,
  "concurrency": 2,
  "pollIntervalSeconds": 10,
  "maxPolls": 15,
  "retryAttempts": 3,
  "uploadDelaySeconds": 3
}
```

Hasil awal masuk `generated/`.
Hasil upscale masuk `upscaled/`.
Hasil upscale dipaksa menjadi JPEG.
Kalau upscale sukses, file asli dihapus.
Kalau upscale gagal, file asli tetap ada dan bisa dijalankan ulang batch terkait.

## Catatan

- Script menggunakan Chrome profile terpisah di `browser-profile/`, jadi Chrome harian tidak dipakai dan tidak bentrok.
- Endpoint upscale adalah endpoint tidak resmi milik ImgUpscaler dan bisa berubah.
- Automation Meta AI tetap punya risiko terhadap akun. Gunakan secara wajar.
