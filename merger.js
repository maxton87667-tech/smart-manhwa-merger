const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const archiver = require('archiver');
const axios = require('axios');
const FormData = require('form-data');
const { execSync } = require('child_process');

const rawFolder = path.join(__dirname, 'raw_chapters');
const processedFolder = path.join(__dirname, 'processed_chapters');

// Configurations
const TARGET_WIDTH = 720;
const CROP_PIXELS = 365;
const IMAGES_PER_SLICE = 10;
const MAIN_REPO_URL = `https://x-access-token:${process.env.GH_PAT}@github.com/maxton87667-tech/Comics.git`;

async function processImages() {
    if (!fs.existsSync(rawFolder)) {
        console.log("No raw_chapters folder found. Exiting...");
        process.exit(0);
    }
    if (!fs.existsSync(processedFolder)) fs.mkdirSync(processedFolder);

    const chapters = fs.readdirSync(rawFolder).filter(f => fs.statSync(path.join(rawFolder, f)).isDirectory());
    
    for (const chapter of chapters) {
        console.log(`Processing Chapter: ${chapter}`);
        const chapterDir = path.join(rawFolder, chapter);
        const outDir = path.join(processedFolder, `ch${chapter}`);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        let files = fs.readdirSync(chapterDir).filter(f => f.match(/\.(jpg|jpeg|png|webp)$/i));
        files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); // Natural sort

        let sliceIndex = 1;
        let globalImageIndex = 0;

        for (let i = 0; i < files.length; i += IMAGES_PER_SLICE) {
            const batchFiles = files.slice(i, i + IMAGES_PER_SLICE);
            let totalHeight = 0;
            let imagesData = [];

            for (const file of batchFiles) {
                const filePath = path.join(chapterDir, file);
                const metadata = await sharp(filePath).metadata();
                
                const scale = TARGET_WIDTH / metadata.width;
                const scaledHeight = Math.round(metadata.height * scale);
                
                const currentCrop = (globalImageIndex === 0) ? 0 : CROP_PIXELS;
                const cropScaled = Math.round(currentCrop / scale);
                const actualCrop = Math.min(cropScaled, metadata.height - 1);
                
                const finalDrawnHeight = scaledHeight - currentCrop;

                const processedBuffer = await sharp(filePath)
                    .extract({ left: 0, top: actualCrop, width: metadata.width, height: metadata.height - actualCrop })
                    .resize(TARGET_WIDTH)
                    .toBuffer();

                imagesData.push({ buffer: processedBuffer, height: finalDrawnHeight });
                totalHeight += finalDrawnHeight;
                globalImageIndex++;
            }

            const canvas = sharp({
                create: {
                    width: TARGET_WIDTH,
                    height: totalHeight,
                    channels: 4,
                    background: { r: 255, g: 255, b: 255, alpha: 1 }
                }
            });

            let yOffset = 0;
            const compositeList = imagesData.map(img => {
                const comp = { input: img.buffer, top: yOffset, left: 0 };
                yOffset += img.height;
                return comp;
            });

            if (fs.existsSync('watermark.png')) {
                // Watermark logic for server-side
                compositeList.push({ input: 'watermark.png', gravity: 'southeast', blend: 'over' });
            }

            const outPath = path.join(outDir, `${String(sliceIndex).padStart(3, '0')}.webp`);
            await canvas.composite(compositeList).webp({ quality: 95 }).toFile(outPath);
            
            console.log(`Saved merged slice ${sliceIndex} for chapter ${chapter}`);
            sliceIndex++;
        }
    }
}

async function createZip() {
    return new Promise((resolve, reject) => {
        console.log("Packaging ZIP for Telegram Backup...");
        const zipName = 'Merged_Backup.zip';
        const output = fs.createWriteStream(zipName);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        output.on('close', () => resolve(zipName));
        archive.on('error', err => reject(err));
        
        archive.pipe(output);
        archive.directory(processedFolder, false);
        archive.finalize();
    });
}

async function sendToTelegram(zipPath) {
    console.log("Sending to Telegram Backup Channel...");
    const form = new FormData();
    form.append('chat_id', process.env.CHAT_ID);
    form.append('document', fs.createReadStream(zipPath));
    
    try {
        await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, form, {
            headers: form.getHeaders()
        });
        console.log("✅ Successfully Uploaded to Telegram!");
    } catch (error) {
        console.error("❌ Telegram Upload Failed:", error.message);
    }
}

function uploadToMainRepo() {
    console.log("Uploading Final Images to Comics Repo...");
    try {
        execSync(`git clone ${MAIN_REPO_URL} main_repo`);
        execSync(`cp -r ${processedFolder}/* main_repo/`);
        
        process.chdir('main_repo');
        execSync(`git config user.name "GitHub Actions"`);
        execSync(`git config user.email "actions@github.com"`);
        execSync(`git add .`);
        execSync(`git commit -m "Auto-uploaded processed chapters via Smart Tool" || echo "No changes"`);
        execSync(`git push`);
        console.log("✅ Successfully pushed to Comics repository!");
    } catch (err) {
        console.error("❌ Git Push Failed:", err.message);
    }
}

async function run() {
    await processImages();
    const zipPath = await createZip();
    await sendToTelegram(zipPath);
    uploadToMainRepo();
}

run();
