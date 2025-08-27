// Modified resizeImages.js
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();

// Utility to normalize filenames by replacing special characters
const normalizeFilename = (filename) => {
    // Decompose special characters and remove diacritics
    let normalized = filename
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    // Replace non-alphanumeric characters (except dots and hyphens) with underscores
    normalized = normalized.replace(/[^a-zA-Z0-9.-]/g, '_');
    return normalized;
};

// Utility to retry file deletion with exponential backoff
async function retryUnlink(filePath, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await fsPromises.unlink(filePath);
            console.log(`Deleted original file: ${filePath}`);
            return;
        } catch (error) {
            if (error.code === 'EPERM' && attempt < maxRetries) {
                console.warn(`Attempt ${attempt} failed to delete ${filePath}: ${error.message}. Retrying after ${500 * Math.pow(2, attempt - 1)}ms`);
                await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
            } else {
                console.warn(`Could not delete original ${filePath}: ${error.message}`);
                return;
            }
        }
    }
}

async function resizeImage(filePath) {
    try {
        console.log(`Resizing ${filePath}`);

        // Validate input file accessibility
        try {
            await fsPromises.access(filePath, fs.constants.R_OK);
        } catch (error) {
            throw new Error(`Input file inaccessible: ${error.message}`);
        }

        // Normalize the output filename
        const baseName = path.basename(filePath, path.extname(filePath));
        const normalizedBaseName = normalizeFilename(baseName);
        const outputPath = path.join(path.dirname(filePath), `${normalizedBaseName}.jpg`);
        const tempPath = outputPath + '.tmp';

        // Load the image and validate
        let image;
        try {
            image = sharp(filePath);
            const metadata = await image.metadata();
            if (!metadata.width || !metadata.height) {
                throw new Error('Invalid image: no dimensions');
            }
        } catch (error) {
            throw new Error(`Failed to read image: ${error.message}`);
        }

        // Convert to RGB if necessary (handles PNG with alpha, etc.)
        image.toFormat('jpeg');

        // Get image dimensions
        const metadata = await image.metadata();
        const width = metadata.width;
        const height = metadata.height;
        const isVertical = height > width;

        // Define target dimensions (height = 1200, 16:9 aspect ratio)
        const targetHeight = 1200;
        const targetWidth = Math.round(targetHeight * (16 / 9)); // Approx 2133 pixels

        if (isVertical) {
            // Step 1: Resize the original image to height 1200
            const aspectRatio = width / height;
            const newWidth = Math.round(targetHeight * aspectRatio);
            const resizedImage = await image
                .resize({ height: targetHeight, width: newWidth, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .toBuffer();

            // Step 2: Create a blurred background
            const blurredImage = await image
                .resize({ width: targetWidth, height: targetHeight, fit: 'cover' })
                .blur(50)
                .toBuffer();

            // Step 3: Composite the resized image on the blurred background
            const left = Math.round((targetWidth - newWidth) / 2);
            const top = 0; // Align to top since height is 1200
            await sharp(blurredImage)
                .composite([{ input: resizedImage, left, top }])
                .jpeg({ quality: 95 })
                .toFile(tempPath);
        } else {
            // For horizontal images, resize to height 1200
            await image
                .resize({ height: targetHeight })
                .jpeg({ quality: 95 })
                .toFile(tempPath);
        }

        // Rename temp file to final output
        try {
            await fsPromises.rename(tempPath, outputPath);
        } catch (error) {
            await fsPromises.unlink(tempPath).catch(() => {});
            throw new Error(`Failed to rename temp file: ${error.message}`);
        }

        // Delete original file if it's not already a .jpg
        if (filePath.toLowerCase() !== outputPath.toLowerCase()) {
            await retryUnlink(filePath);
        }

        console.log(`Finished resizing to ${path.basename(outputPath)}`);

        // Upload to S3
        const bucketName = 'project-synapse-processed-data-vinesh';
        await s3.upload({
            Bucket: bucketName,
            Key: `resized/${path.basename(outputPath)}`,
            Body: fsSync.createReadStream(outputPath),
            ContentType: 'image/jpeg',
        }).promise();

        return { localPath: outputPath, s3Url: `https://${bucketName}.s3.amazonaws.com/resized/${path.basename(outputPath)}` };
    } catch (error) {
        console.error(`Error resizing ${filePath}: ${error.message}`);
        throw error;
    }
}

async function startResizing(folderPath) {
    try {
        if (!folderPath) {
            throw new Error('Folder path is required');
        }

        // Validate folder permissions
        try {
            await fsPromises.access(folderPath, fs.constants.R_OK | fs.constants.W_OK);
        } catch (error) {
            throw new Error(`Cannot access folder ${folderPath}: ${error.message}`);
        }

        console.log('Initializing folder');
        await fsPromises.mkdir(folderPath, { recursive: true }).catch(() => {});
        const files = await fsPromises.readdir(folderPath);
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.avif'];
        console.log(`Supported image formats: ${imageExtensions.join(', ')}`);
        const imageFiles = files.filter(file => 
            imageExtensions.includes(path.extname(file).toLowerCase())
        );

        console.log(`Found ${imageFiles.length} image files in ${folderPath}`);

        if (imageFiles.length === 0) {
            throw new Error('No images found to resize. Supported formats: ' + imageExtensions.join(', '));
        }

        console.log('Processing images');
        let processedCount = 0;
        let skippedCount = 0;
        const totalImages = imageFiles.length;
        const s3Urls = [];

        for (const file of imageFiles) {
            const filePath = path.join(folderPath, file);
            try {
                const result = await resizeImage(filePath);
                s3Urls.push(result.s3Url);
                processedCount++;
            } catch (error) {
                console.error(`Skipping ${file} due to error`);
                skippedCount++;
            }
        }

        console.log('Finalizing resizing');
        console.log(`All image resizes completed! Processed ${processedCount} images, skipped ${skippedCount} images. All images saved as .jpg`);
        return { message: `Image resizing complete! Processed ${processedCount} images, skipped ${skippedCount} images. All images saved as .jpg`, s3Urls };
    } catch (error) {
        console.error('Error processing folder:', error.message);
        throw error;
    }
}

module.exports = { startResizing };