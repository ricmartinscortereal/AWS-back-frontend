const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const he = require('he');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const { Translate } = require('@google-cloud/translate').v2;
const { parse } = require('csv-parse');
require('dotenv').config();
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const s3 = new AWS.S3();
const dynamoDb = new AWS.DynamoDB.DocumentClient({ region: 'eu-north-1' });
const dynamodbRaw = new AWS.DynamoDB({ region: 'eu-north-1' });
const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('rebrowser-puppeteer-core');

// Initialize Airtable
const Airtable = require('airtable');
const airtableApiKey = process.env.AIRTABLE_API_KEY;
const airtableBaseId = process.env.AIRTABLE_BASE_ID;
const airtableTableName = process.env.AIRTABLE_TABLE_NAME || 'Dishes';
const airtableOptionTableName = process.env.AIRTABLE_OPTION_TABLE_NAME || 'OptionGroups';
const airtableOptionsTableName = process.env.AIRTABLE_OPTIONS_TABLE_NAME || 'Options';
if (!airtableApiKey || !airtableBaseId) {
    throw new Error('Airtable configuration missing. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in .env');
}
const base = new Airtable({ apiKey: airtableApiKey }).base(airtableBaseId);

// Initialize Google Cloud Translate
const translateClient = new Translate({
    key: process.env.GOOGLE_TRANSLATE_API_KEY
});

// Translation cache
const translationCache = {};
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const normalizeText = (text) => {
    if (!text) return '';
    const decoded = he.decode(text);
    return decoded.normalize('NFC').trim();
};

const sanitizeText = (text) => {
    if (!text) return '';
    return text.replace(/[^\x00-\x7F\u0400-\u04FF]/g, (char) => {
        try {
            return Buffer.from(char, 'utf8').toString('utf8') === char ? char : '?';
        } catch {
            return '?';
        }
    }).trim();
};

const cleanPrice = (price) => {
    if (!price) return '0.00';
    if (typeof price === 'string' && price.includes('/')) {
        const priceVariants = price.split('/').map(p => {
            let cleaned = p.replace(/[^0-9.,]/g, '').replace(/,/g, '.').trim();
            return parseFloat(cleaned) || 0;
        });
        const number = Math.min(...priceVariants);
        return number.toFixed(2);
    } else {
        let cleaned = price.toString().replace(/[^0-9.,]/g, '').replace(/,/g, '.');
        const number = parseFloat(cleaned) || 0;
        return number.toFixed(2);
    }
};

const sanitizeFilename = (filename, preserveSpecial = false) => {
    if (!filename) return 'unknown';
    const normalized = filename.normalize('NFC');
    let sanitized = normalized;
    if (preserveSpecial) {
        sanitized = normalized.replace(/[^a-zA-Z0-9ł]/g, '_').replace(/_+/g, '_').toLowerCase().trim();
    } else {
        sanitized = normalized.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase().trim();
    }
    return sanitized.substring(0, 20);
};

const generateDishId = (dishName, usedIds) => {
    if (!dishName) return 'unknownDish';
    const normalized = dishName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .trim();
    let words = normalized.split(/[\s-]+/);
    words = words.filter(word => word);
    if (words.length === 0) return 'unknownDish';
    const camelCaseId = words
        .map((word, index) => {
            const lower = word.toLowerCase();
            return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join('');
    let finalId = camelCaseId;
    let suffix = 1;
    while (usedIds.has(finalId)) {
        finalId = `${camelCaseId}${suffix}`;
        suffix++;
    }
    usedIds.add(finalId);
    console.log(`Generated ID for "${dishName}": ${finalId}`);
    return finalId;
};

const assignTags = (dishName) => {
    const tags = [];
    if (!dishName) return tags;
    const lowerDishName = dishName.toLowerCase();
    const spicyKeywords = ['iut', 'picant', 'hrean', 'hot', 'chilli', 'chili', 'jalapeno', 'pepperonci', 'peperonci', 'wasabi', 'siracha'];
    if (spicyKeywords.some(keyword => lowerDishName.includes(keyword))) {
        tags.push('spicy');
    }
    if (lowerDishName.includes('vegan')) {
        tags.push('vegan');
    }
    const vegetarianKeywords = ['vegetarian', 'veggie', 'vegetal'];
    if (vegetarianKeywords.some(keyword => lowerDishName.includes(keyword))) {
        tags.push('vegetarian');
    }
    if (lowerDishName.includes('halal')) {
        tags.push('halal');
    }
    return tags;
};

const supportedLanguages = {
    'sq': 'Albanian', 'eu': 'Basque', 'be': 'Belarusian', 'bs': 'Bosnian', 'bg': 'Bulgarian',
    'ca': 'Catalan', 'hr': 'Croatian', 'cs': 'Czech', 'da': 'Danish', 'nl': 'Dutch',
    'en': 'English', 'et': 'Estonian', 'fi': 'Finnish', 'fr': 'French', 'gl': 'Galician',
    'de': 'German', 'el': 'Greek', 'hu': 'Hungarian', 'is': 'Icelandic', 'ga': 'Irish',
    'it': 'Italian', 'lv': 'Latvian', 'lt': 'Lithuanian', 'lb': 'Luxembourgish', 'mk': 'Macedonian',
    'mt': 'Maltese', 'no': 'Norwegian', 'pl': 'Polish', 'pt': 'Portuguese', 'ro': 'Romanian',
    'sr': 'Serbian', 'sk': 'Slovak', 'sl': 'Slovenian', 'es': 'Spanish', 'sv': 'Swedish',
    'ua': 'Ukrainian'
};

async function translateText(text, sourceLang) {
    if (!text || text.trim() === '') {
        console.log('No text to translate');
        return '';
    }
    const cacheKey = `${text}:${sourceLang}`;
    if (translationCache[cacheKey]) {
        console.log(`Using cached translation for "${text}" (${sourceLang}): "${translationCache[cacheKey]}"`);
        return translationCache[cacheKey];
    }
    try {
        if (!supportedLanguages[sourceLang]) {
            console.warn(`Unsupported source language: ${sourceLang}. Using original text: "${text}"`);
            return text;
        }
        if (sourceLang === 'en') {
            console.log('Text is already in English');
            return text;
        }
        const maxRetries = 3;
        let attempt = 1;
        while (attempt <= maxRetries) {
            try {
                const [translation] = await translateClient.translate(text, {
                    from: sourceLang,
                    to: 'en'
                });
                console.log(`Translated to en-US: "${translation}"`);
                translationCache[cacheKey] = translation;
                return translation;
            } catch (error) {
                console.error(`Translation attempt ${attempt} failed: ${error.message}`);
                if (attempt === maxRetries) {
                    console.warn(`Translation failed after ${maxRetries} attempts. Using original text: "${text}"`);
                    translationCache[cacheKey] = text;
                    return text;
                }
                await delay(1000 * Math.pow(2, attempt - 1));
                attempt++;
            }
        }
    } catch (error) {
        console.error(`Error processing text: "${text}": ${error.message}`);
        translationCache[cacheKey] = text;
        return text;
    }
}

async function ensureOutputDir(dir) {
    await fs.mkdir(dir, { recursive: true }).catch(err => console.error(`Failed to create directory ${dir}: ${err.message}`));
    console.log(`Output directory ready: ${dir}`);
}


async function uploadImageToS3(imagePath, dishName, restaurantName) {
    const bucketName = 'synapseimage';
    const sanitizedDishName = sanitizeFilename(dishName, true);
    const key = `images/${restaurantName}/${sanitizedDishName}-${Date.now()}.jpg`;
    try {
        const fileContent = await fs.readFile(imagePath);
        const params = {
            Bucket: bucketName,
            Key: key,
            Body: fileContent,
            ContentType: 'image/jpeg',
        };
        const data = await s3.upload(params).promise();
        const publicUrl = `https://${bucketName}.s3.amazonaws.com/${key}`;
        console.log(`Uploaded image for ${dishName}: ${publicUrl}`);
        return { url: publicUrl, filename: path.basename(key) };
    } catch (error) {
        console.error(`Failed to upload ${imagePath}: ${error.message}`);
        return null;
    }
}


async function importToAirtable(dishCsvPath, imageDir, restaurantName, sourceLang, restaurantUrl, scrapeTimestamp, optionGroupCsvPath, optionCsvPath) {
    try {
        console.log(`Reading Dishes CSV: ${dishCsvPath}, Option Groups CSV: ${optionGroupCsvPath}, Options CSV: ${optionCsvPath}`);
        console.log('Uploading to Airtable');
        // Delete existing records to prevent duplicates
        const deleteRecords = async (tableName) => {
            const records = await base(tableName).select().all();
            const recordIds = records.map(record => record.id);
            if (recordIds.length > 0) {
                const batchSize = 10;
                for (let i = 0; i < recordIds.length; i += batchSize) {
                    const batch = recordIds.slice(i, i + batchSize);
                    await base(tableName).destroy(batch);
                    console.log(`Deleted ${batch.length} records from ${tableName}`);
                }
            }
        };
        await deleteRecords(airtableTableName);
        await deleteRecords(airtableOptionTableName);
        await deleteRecords(airtableOptionsTableName);

        const dishRecords = [];
        const usedIds = new Set();
        const dishParser = fsSync.createReadStream(dishCsvPath)
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true,
                encoding: 'utf8'
            }));
        for await (const record of dishParser) {
            if (!record['Dish Name'] || !record['Dish Name en-US']) {
                console.warn(`Skipping invalid dish record: ${JSON.stringify(record)}`);
                continue;
            }
            let imageAttachment = [];
            if (record.Image && record.Image.startsWith('https://')) {
                imageAttachment = [{ url: record.Image, filename: path.basename(record.Image) }];
                console.log(`Using S3 URL for ${record['Dish Name']}: ${record.Image}`);
            } else if (record.Image) {
                console.warn(`Invalid S3 URL in CSV for ${record['Dish Name']}: ${record.Image}`);
            }
            const tags = assignTags(record['Dish Name']);
            const id = generateDishId(record['Dish Name'], usedIds);
            dishRecords.push({
                fields: {
                    'ID': id,
                    'Category': sanitizeText(record.Category || ''),
                    'Dish Name': sanitizeText(record['Dish Name'] || ''),
                    'Dish Name en-US': sanitizeText(record['Dish Name en-US'] || ''),
                    'Price': parseFloat(cleanPrice(record.Price)) || 0,
                    'Description': sanitizeText(record.Description || ''),
                    'Description en-US': sanitizeText(record['Description en-US'] || ''),
                    'Image': imageAttachment,
                    'Tags': tags.join(', '),
                    'Option Groups': record['Option Groups'] || ''
                }
            });
        }

        const optionGroupRecords = [];
        const usedOptionGroupIds = new Set();
        const optionGroupParser = fsSync.createReadStream(optionGroupCsvPath)
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true,
                encoding: 'utf8'
            }));
        for await (const record of optionGroupParser) {
            if (!record['Option Group ID'] || !record.Name || !record['Name en-US'] || !record.Option_group_type) {
                console.warn(`Skipping option group with empty Name, Name en-US, or Option_group_type: ${JSON.stringify(record)}`);
                continue;
            }
            const groupId = record['Option Group ID'];
            if (usedOptionGroupIds.has(groupId)) {
                console.warn(`Skipping duplicate option group ID: ${groupId}`);
                continue;
            }
            usedOptionGroupIds.add(groupId);
            optionGroupRecords.push({
                fields: {
                    'Option Group ID': groupId,
                    'Name': sanitizeText(record.Name || ''),
                    'Name en-US': sanitizeText(record['Name en-US'] || ''),
                    'Option_group_type': record.Option_group_type || 'multi_select',
                    'Option_group_min': parseInt(record.Option_group_min) || 0,
                    'Option_group_max': parseInt(record.Option_group_max) || 0,
                    'Option_group_eachMax': parseInt(record.Option_group_eachMax) || 1,
                    'Dish URL': record['Dish URL'] || '',
                    'Options': record.Options ? record.Options.split(', ').filter(opt => opt.trim()) : [],
                    'Dishes': record.Dishes ? record.Dishes.split(', ').filter(dish => dish.trim()) : []
                }
            });
        }

        const optionRecords = [];
        const usedOptionIds = new Set();
        const optionParser = fsSync.createReadStream(optionCsvPath)
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true,
                encoding: 'utf8'
            }));
        for await (const record of optionParser) {
            if (!record['Option ID']) {
                console.warn(`Skipping option with empty Option ID: ${JSON.stringify(record)}`);
                continue;
            }
            const optionId = record['Option ID'];
            if (usedOptionIds.has(optionId)) {
                console.warn(`Skipping duplicate option ID: ${optionId}`);
                continue;
            }
            usedOptionIds.add(optionId);
            optionRecords.push({
                fields: {
                    'Option ID': optionId,
                    'Price': parseFloat(cleanPrice(record.Price || '0.00')) || 0,
                    'Name': sanitizeText(record.Name || ''),
                    'Name en-US': sanitizeText(record['Name en-US'] || ''),
                    'Option Groups': record['Option Groups'] ? record['Option Groups'].split(', ').filter(og => og.trim()) : []
                }
            });
        }

        // Batch write to Airtable
        const batchSize = 10;
        let successfulUploads = 0;
        for (let i = 0; i < dishRecords.length; i += batchSize) {
            const batch = dishRecords.slice(i, i + batchSize);
            console.log(`Uploading dish batch ${i / batchSize + 1} (${batch.length} records)`);
            const maxRetries = 3;
            let attempt = 1;
            while (attempt <= maxRetries) {
                try {
                    await base(airtableTableName).create(batch, { typecast: true });
                    successfulUploads += batch.length;
                    console.log(`Successfully uploaded dish batch ${i / batchSize + 1}`);
                    await delay(1000);
                    break;
                } catch (error) {
                    console.error(`Error uploading dish batch ${i / batchSize + 1}, attempt ${attempt}: ${error.message}`);
                    if (attempt === maxRetries) {
                        console.warn(`Failed to upload dish batch ${i / batchSize + 1} after ${maxRetries} attempts`);
                        break;
                    }
                    await delay(1000 * Math.pow(2, attempt - 1));
                    attempt++;
                }
            }
        }
        for (let i = 0; i < optionGroupRecords.length; i += batchSize) {
            const batch = optionGroupRecords.slice(i, i + batchSize);
            console.log(`Uploading option group batch ${i / batchSize + 1} (${batch.length} records)`);
            if (batch.length > 0) {
                console.log('Sample option group record:', JSON.stringify(batch[0], null, 2));
            } else {
                console.warn('No option group records in batch, check option groups CSV');
            }
            const maxRetries = 3;
            let attempt = 1;
            while (attempt <= maxRetries) {
                try {
                    await base(airtableOptionTableName).create(batch, { typecast: true });
                    successfulUploads += batch.length;
                    console.log(`Successfully uploaded option group batch ${i / batchSize + 1}`);
                    await delay(1000);
                    break;
                } catch (error) {
                    console.error(`Error uploading option group batch ${i / batchSize + 1}, attempt ${attempt}: ${error.message}`);
                    console.error('Error details:', JSON.stringify(error, null, 2));
                    if (attempt === maxRetries) {
                        console.warn(`Failed to upload option group batch ${i / batchSize + 1} after ${maxRetries} attempts`);
                        break;
                    }
                    await delay(1000 * Math.pow(2, attempt - 1));
                    attempt++;
                }
            }
        }
        for (let i = 0; i < optionRecords.length; i += batchSize) {
            const batch = optionRecords.slice(i, i + batchSize);
            console.log(`Uploading options batch ${i / batchSize + 1} (${batch.length} records)`);
            if (batch.length > 0) {
                console.log('Sample option record:', JSON.stringify(batch[0], null, 2));
            } else {
                console.warn('No option records in batch, check options CSV');
            }
            const maxRetries = 3;
            let attempt = 1;
            while (attempt <= maxRetries) {
                try {
                    await base(airtableOptionsTableName).create(batch, { typecast: true });
                    successfulUploads += batch.length;
                    console.log(`Successfully uploaded options batch ${i / batchSize + 1}`);
                    await delay(1000);
                    break;
                } catch (error) {
                    console.error(`Error uploading options batch ${i / batchSize + 1}, attempt ${attempt}: ${error.message}`);
                    console.error('Error details:', JSON.stringify(error, null, 2));
                    if (attempt === maxRetries) {
                        console.warn(`Failed to upload options batch ${i / batchSize + 1} after ${maxRetries} attempts`);
                        break;
                    }
                    await delay(1000 * Math.pow(2, attempt - 1));
                    attempt++;
                }
            }
        }
        console.log(`Successfully imported ${successfulUploads} records to Airtable`);
        return `Imported ${successfulUploads} records to Airtable`;
    } catch (error) {
        console.error(`Error importing to Airtable: ${error.message}`);
        throw error;
    }
}

async function importToDynamoDB(dishCsvPath, imageDir, restaurantName, sourceLang, restaurantUrl, scrapeTimestamp, optionGroupCsvPath, optionCsvPath) {
    try {
        console.log(`Reading Dishes CSV: ${dishCsvPath}, Option Groups CSV: ${optionGroupCsvPath}, Options CSV: ${optionCsvPath}`);
        const dishItems = [];
        const usedIds = new Set();
        const dishParser = fsSync.createReadStream(dishCsvPath)
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true,
                encoding: 'utf8'
            }));
        for await (const record of dishParser) {
            let imageUrl = '';
            if (record.Image && record.Image.startsWith('https://')) {
                imageUrl = record.Image;
                console.log(`Using S3 URL for ${record['Dish Name']}: ${imageUrl}`);
            } else if (record.Image) {
                console.warn(`Invalid S3 URL in CSV for ${record['Dish Name']}: ${record.Image}`);
            }
            const tags = assignTags(record['Dish Name']);
            const translatedDescription = sanitizeText(record['Description en-US'] || '');
            const translatedDishName = sanitizeText(record['Dish Name en-US'] || '');
            const dishName = sanitizeText(record['Dish Name'] || '');
            const description = sanitizeText(record.Description || '');
            const category = sanitizeText(record.Category || '');
            const id = generateDishId(dishName, usedIds);
            const scrapeDate = scrapeTimestamp && typeof scrapeTimestamp === 'string' && scrapeTimestamp.includes('T')
                ? scrapeTimestamp.split('T')[0]
                : new Date().toISOString().split('T')[0];
            const dishItem = {
                ID: id,
                RestaurantName: restaurantName,
                Category: category,
                DishName: dishName,
                DishNameEnUS: translatedDishName,
                Price: parseFloat(record.Price) || 0,
                Description: description,
                DescriptionEnUS: translatedDescription,
                Image: imageUrl,
                Tags: tags,
                ScrapeDate: scrapeDate,
                ScrapeTimestamp: scrapeTimestamp,
                RestaurantURL: restaurantUrl,
                OptionGroups: record['Option Groups'] || ''
            };
            dishItems.push(dishItem);
        }

        const optionItems = [];
        const usedOptionIds = new Set();
        const optionParser = fsSync.createReadStream(optionCsvPath)
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true,
                encoding: 'utf8'
            }));
        for await (const record of optionParser) {
            if (!record['Option ID'] || !record['Name'] || !record['Name en-US'] || usedOptionIds.has(record['Option ID'])) {
                console.warn(`Skipping invalid or duplicate option record: ${JSON.stringify(record)}`);
                continue;
            }
            usedOptionIds.add(record['Option ID']);
            const scrapeDate = scrapeTimestamp && typeof scrapeTimestamp === 'string' && scrapeTimestamp.includes('T')
                ? scrapeTimestamp.split('T')[0]
                : new Date().toISOString().split('T')[0];
            const optionItem = {
                OptionID: record['Option ID'] || '',
                RestaurantName: restaurantName,
                Price: parseFloat(record.Price) || 0,
                ExtractedItemName: sanitizeText(record.Name || ''),
                TranslatedItemName: sanitizeText(record['Name en-US'] || ''),
                OptionGroups: record['Option Groups'] ? record['Option Groups'].split(', ').filter(og => og) : [],
                ScrapeDate: scrapeDate,
                ScrapeTimestamp: scrapeTimestamp,
                RestaurantURL: restaurantUrl
            };
            optionItems.push(optionItem);
        }

        const optionGroupItems = [];
        const usedOptionGroupIds = new Set();
        const optionGroupParser = fsSync.createReadStream(optionGroupCsvPath)
            .pipe(parse({
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true,
                encoding: 'utf8'
            }));
        for await (const record of optionGroupParser) {
            if (!record['Option Group ID'] || !record['Name'] || usedOptionGroupIds.has(record['Option Group ID']) || !record['Options']) {
                console.warn(`Skipping invalid or duplicate option group record: ${JSON.stringify(record)}`);
                continue;
            }
            usedOptionGroupIds.add(record['Option Group ID']);
            const scrapeDate = scrapeTimestamp && typeof scrapeTimestamp === 'string' && scrapeTimestamp.includes('T')
                ? scrapeTimestamp.split('T')[0]
                : new Date().toISOString().split('T')[0];
            const optionGroupItem = {
                OptionGroupID: record['Option Group ID'] || '',
                RestaurantName: restaurantName,
                Name: record['Name'] || '',
                NameEnUS: record['Name en-US'] || '',
                OptionGroupType: record['Option_group_type'] || 'multi_select',
                OptionGroupMin: parseInt(record['Option_group_min']) || 0,
                OptionGroupMax: parseInt(record['Option_group_max']) || 0,
                OptionGroupEachMax: parseInt(record['Option_group_eachMax']) || 1,
                DishURL: record['Dish URL'] || '',
                Options: record['Options'] ? record['Options'].split(', ').filter(opt => opt) : [],
                Dishes: record['Dishes'] ? record['Dishes'].split(', ').filter(dish => dish) : [],
                ScrapeDate: scrapeDate,
                ScrapeTimestamp: scrapeTimestamp,
                RestaurantURL: restaurantUrl
            };
            optionGroupItems.push(optionGroupItem);
        }

        if (optionItems.length > 0) {
            console.log('Sample option item for DynamoDB:', JSON.stringify(optionItems[0], null, 2));
        }
        if (optionGroupItems.length > 0) {
            console.log('Sample option group item for DynamoDB:', JSON.stringify(optionGroupItems[0], null, 2));
        }

        const batchSize = 25;
        let successfulUploads = 0;
        for (let i = 0; i < dishItems.length; i += batchSize) {
            const batch = dishItems.slice(i, i + batchSize);
            console.log(`Uploading DynamoDB dish batch ${i / batchSize + 1} (${batch.length} records)`);
            let putRequests = batch.map(item => ({
                PutRequest: { Item: item }
            }));
            let params = {
                RequestItems: { 'Synapse-DB': putRequests }
            };
            const maxRetries = 3;
            let attempt = 1;
            while (attempt <= maxRetries) {
                try {
                    let unprocessed = {};
                    do {
                        const response = await dynamoDb.batchWrite(params).promise();
                        unprocessed = response.UnprocessedItems || {};
                        if (Object.keys(unprocessed).length > 0) {
                            console.log(`Retrying unprocessed items in dish batch ${i / batchSize + 1}`);
                            params.RequestItems = unprocessed;
                            await delay(1000);
                        }
                    } while (Object.keys(unprocessed).length > 0);
                    successfulUploads += batch.length;
                    console.log(`Successfully uploaded DynamoDB dish batch ${i / batchSize + 1}`);
                    await delay(1000);
                    break;
                } catch (error) {
                    console.error(`Error uploading DynamoDB dish batch ${i / batchSize + 1}, attempt ${attempt}: ${error.message}`);
                    console.error('Error details:', JSON.stringify(error, null, 2));
                    console.error('Sample batch item:', JSON.stringify(batch[0], null, 2));
                    if (attempt === maxRetries) {
                        console.warn(`Failed to upload dish batch ${i / batchSize + 1} after ${maxRetries} attempts`);
                        break;
                    }
                    await delay(1000 * Math.pow(2, attempt - 1));
                    attempt++;
                }
            }
        }
        for (let i = 0; i < optionItems.length; i += batchSize) {
            const batch = optionItems.slice(i, i + batchSize);
            console.log(`Uploading DynamoDB option batch ${i / batchSize + 1} (${batch.length} records)`);
            let putRequests = batch.map(item => ({
                PutRequest: { Item: item }
            }));
            let params = {
                RequestItems: { 'Synapse-Options': putRequests }
            };
            const maxRetries = 3;
            let attempt = 1;
            while (attempt <= maxRetries) {
                try {
                    let unprocessed = {};
                    do {
                        const response = await dynamoDb.batchWrite(params).promise();
                        unprocessed = response.UnprocessedItems || {};
                        if (Object.keys(unprocessed).length > 0) {
                            console.log(`Retrying unprocessed items in option batch ${i / batchSize + 1}`);
                            params.RequestItems = unprocessed;
                            await delay(1000);
                        }
                    } while (Object.keys(unprocessed).length > 0);
                    successfulUploads += batch.length;
                    console.log(`Successfully uploaded DynamoDB option batch ${i / batchSize + 1}`);
                    await delay(1000);
                    break;
                } catch (error) {
                    console.error(`Error uploading DynamoDB option batch ${i / batchSize + 1}, attempt ${attempt}: ${error.message}`);
                    console.error('Error details:', JSON.stringify(error, null, 2));
                    console.error('Sample batch item:', JSON.stringify(batch[0], null, 2));
                    if (attempt === maxRetries) {
                        console.warn(`Failed to upload option batch ${i / batchSize + 1} after ${maxRetries} attempts`);
                        break;
                    }
                    await delay(1000 * Math.pow(2, attempt - 1));
                    attempt++;
                }
            }
        }
        for (let i = 0; i < optionGroupItems.length; i += batchSize) {
            const batch = optionGroupItems.slice(i, i + batchSize);
            console.log(`Uploading DynamoDB option group batch ${i / batchSize + 1} (${batch.length} records)`);
            let putRequests = batch.map(item => ({
                PutRequest: { Item: item }
            }));
            let params = {
                RequestItems: { 'Synapse-OptionGroups': putRequests }
            };
            const maxRetries = 3;
            let attempt = 1;
            while (attempt <= maxRetries) {
                try {
                    let unprocessed = {};
                    do {
                        const response = await dynamoDb.batchWrite(params).promise();
                        unprocessed = response.UnprocessedItems || {};
                        if (Object.keys(unprocessed).length > 0) {
                            console.log(`Retrying unprocessed items in option group batch ${i / batchSize + 1}`);
                            params.RequestItems = unprocessed;
                            await delay(1000);
                        }
                    } while (Object.keys(unprocessed).length > 0);
                    successfulUploads += batch.length;
                    console.log(`Successfully uploaded DynamoDB option group batch ${i / batchSize + 1}`);
                    await delay(1000);
                    break;
                } catch (error) {
                    console.error(`Error uploading DynamoDB option group batch ${i / batchSize + 1}, attempt ${attempt}: ${error.message}`);
                    console.error('Error details:', JSON.stringify(error, null, 2));
                    console.error('Sample batch item:', JSON.stringify(batch[0], null, 2));
                    if (attempt === maxRetries) {
                        console.warn(`Failed to upload option group batch ${i / batchSize + 1} after ${maxRetries} attempts`);
                        break;
                    }
                    await delay(1000 * Math.pow(2, attempt - 1));
                    attempt++;
                }
            }
        }
        console.log(`Successfully imported ${successfulUploads} records to DynamoDB`);
        return `Imported ${successfulUploads} records to DynamoDB`;
    } catch (error) {
        console.error(`Error importing to DynamoDB: ${error.message}`);
        throw error;
    }
}

async function createDynamoDBTableIfNotExists() {
    const tables = [
        {
            TableName: 'Synapse-DB',
            KeySchema: [{ AttributeName: 'ID', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'ID', AttributeType: 'S' }],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
        },
        {
            TableName: 'Synapse-Options',
            KeySchema: [{ AttributeName: 'OptionID', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'OptionID', AttributeType: 'S' }],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
        },
        {
            TableName: 'Synapse-OptionGroups',
            KeySchema: [{ AttributeName: 'OptionGroupID', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'OptionGroupID', AttributeType: 'S' }],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
        },
        {
            TableName: 'ScrapeStatus',
            KeySchema: [{ AttributeName: 'jobId', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'jobId', AttributeType: 'S' }],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
        }
    ];
    for (const table of tables) {
        try {
            await dynamodbRaw.describeTable({ TableName: table.TableName }).promise();
            console.log(`Table ${table.TableName} already exists`);
        } catch (error) {
            if (error.code === 'ResourceNotFoundException') {
                console.log(`Creating table ${table.TableName}`);
                await dynamodbRaw.createTable(table).promise();
                await dynamodbRaw.waitFor('tableExists', { TableName: table.TableName }).promise();
                console.log(`Table ${table.TableName} created successfully`);
            } else {
                console.error(`Error checking table ${table.TableName}: ${error.message}`);
                throw error;
            }
        }
    }
}

function parseWoltVenueSlug(restaurantUrl) {
    const venueMatch = restaurantUrl.match(/\/(?:restaurant|venue)\/([^/]+)/);
    if (!venueMatch) {
      throw new Error('Invalid Wolt URL: Could not extract venue slug');
    }
    return venueMatch[1];
  }
  async function scrapeWolt(page, restaurantUrl, restaurantName) {
    console.log('Scraping Wolt.com via API...');
  
    // 1) Extract venue slug and override restaurantName
    let venue;
    try {
      venue = parseWoltVenueSlug(restaurantUrl);
      restaurantName = venue; // Use venue slug as restaurantName
      console.log(`Final restaurantName: ${restaurantName}`);
    } catch (error) {
      console.error(`URL parsing failed: ${error.message}`);
      return {
        dishes: [],
        options: [],
        optionGroups: [],
        startTime: Date.now(),
        counters: { dishes: 0, categories: 0, images: 0, options: 0, optionGroups: 0, tags: 0 }
      };
    }
  
    // 2) Prepare output directory
    const outputDir = path.join('/tmp', 'output', restaurantName, 'pics');
    await ensureOutputDir(outputDir);
    console.log(`Clearing directory ${outputDir}`);
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
      console.log(`Cleared directory ${outputDir}`);
      await ensureOutputDir(outputDir);
    } catch (error) {
      console.error(`Failed to clear directory ${outputDir}: ${error.message}`);
    }
    try {
      const tmpFiles = await fs.readdir(path.join('/tmp', 'output')).catch(() => []);
      console.log(`Contents of /tmp/output: ${tmpFiles.join(', ')}`);
    } catch (error) {
      console.error(`Failed to list /tmp/output contents: ${error.message}`);
    }
  
    // 3) Set up headers (remove hardcoded cookie)
    const headers = {
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Not)A;Brand";v="99", "Google Chrome";v="129", "Chromium";v="129"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    };
  
    // 4) Fetch menu data
    const apiUrl = `https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/${venue}/assortment/`;
    console.log(`Fetching Wolt API: ${apiUrl}`);
    const maxRetries = 3;
    let apiResponse = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get(apiUrl, { headers });
        if (response.status === 200) {
          apiResponse = response.data;
          break;
        } else if (response.status === 429) {
          console.warn(`Rate limit hit on attempt ${attempt}, retrying after delay`);
          await delay(1000 * Math.pow(2, attempt - 1));
        } else {
          throw new Error(`API request failed with status ${response.status}`);
        }
      } catch (error) {
        console.error(`API attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) {
          console.error(`Failed to fetch Wolt API after ${maxRetries} attempts: ${error.message}`);
          return {
            dishes: [],
            options: [],
            optionGroups: [],
            startTime: Date.now(),
            counters: { dishes: 0, categories: 0, images: 0, options: 0, optionGroups: 0, tags: 0 }
          };
        }
        await delay(1000 * Math.pow(2, attempt - 1));
      }
    }
    if (!apiResponse) {
      console.error('Failed to retrieve Wolt API data');
      return {
        dishes: [],
        options: [],
        optionGroups: [],
        startTime: Date.now(),
        counters: { dishes: 0, categories: 0, images: 0, options: 0, optionGroups: 0, tags: 0 }
      };
    }
  
    // 5) Parse API response
    const menuUrl = restaurantUrl.endsWith('/') ? restaurantUrl : `${restaurantUrl}/`;
    const categories = apiResponse.categories || [];
    const items = apiResponse.items || [];
    const options = apiResponse.options || [];
    const categoryMap = new Map();
    const categorySet = new Set();
    for (const category of categories) {
      const categoryName = normalizeText(category.name || 'Unknown Category');
      categorySet.add(categoryName);
      for (const itemId of category.item_ids || []) {
        categoryMap.set(itemId, categoryName);
      }
    }
  
    // 6) Process items
    const dishes = [];
    const optionsList = [];
    const optionGroups = [];
    const usedIds = new Set();
    const usedOptionIds = new Map();
    const usedOptionGroupIds = new Map();
    let imageCount = 0;
    let tagCount = 0;
    let optionCount = 0;
    let optionGroupCount = 0;
    const s3KeysToDelete = [];
  
    for (const item of items) {
      const itemId = item.id || '';
      const categoryName = categoryMap.get(itemId) || 'Unknown Category';
      const dishId = generateDishId(item.name, usedIds);
      let imagePath = '';
      let imageAttachment = [];
      const imageUrl = item.images?.[0]?.url || '';
      if (imageUrl && imageUrl.startsWith('http')) {
        const safeName = sanitizeFilename(item.name, true);
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        const maxBaseLength = 50 - (uniqueId.length + 5);
        const finalBaseName = safeName.substring(0, maxBaseLength);
        const filePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
        try {
          const downloadResult = await downloadImage(restaurantUrl, imageUrl, filePath, restaurantName, item.name);
          if (downloadResult && fsSync.existsSync(filePath)) {
            s3KeysToDelete.push(downloadResult.s3Key);
            const resizeResult = await resizeImage(downloadResult.s3Key, filePath, restaurantName, item.name);
            if (resizeResult) {
              imagePath = resizeResult.url;
              imageAttachment = [{ url: resizeResult.url, filename: resizeResult.filename }];
              imageCount++;
              console.log(`Image processed for ${item.name}: ${resizeResult.url}`);
            } else {
              console.warn(`Failed to resize image for ${item.name} from s3://synapseimage/${downloadResult.s3Key}`);
            }
          } else {
            console.warn(`Image download failed for ${item.name}: ${filePath}`);
          }
        } catch (error) {
          console.error(`Failed to process image for ${item.name}: ${error.message}`);
          await fs.unlink(filePath).catch(() => {});
        }
      } else {
        console.log(`No valid image URL for ${item.name}`);
      }
  
      const originalPrice = item.original_price || item.price;
      const currentPrice = item.price;
      const regularPrice = (originalPrice / 100).toFixed(2) || (currentPrice / 100).toFixed(2) || '0.00';
      const alcoholPermille = item.alcohol_permille;
      const percentageAlcohol = alcoholPermille != null ? `${(alcoholPermille / 10).toFixed(1)}%` : '';
      const tags = assignTags(item.name);
      tagCount += tags.length;
      const dishOptionGroupIds = [];
  
      dishes.push({
        id: dishId,
        category: categoryName,
        dishName: normalizeText(item.name || ''),
        price: regularPrice,
        description: normalizeText(item.description || ''),
        image: imagePath,
        optionGroups: '',
        percentageAlcohol: percentageAlcohol,
        tags: tags,
        imageAttachment
      });
  
      const itemOptions = new Map();
      for (const opt of item.options || []) {
        const optionId = opt.option_id;
        const option = options.find(o => o.id === optionId);
        if (option) {
          const optionGroupName = normalizeText(option.name || '');
          if (!optionGroupName) continue;
          const isCounterType = optionGroupName.toLowerCase().includes('sos') || optionGroupName.toLowerCase().includes('dodatki');
          const optionGroupType = isCounterType || option.type === 'counter' ? 'counter' : 'multi_select';
          let optionGroupId;
          if (!usedOptionGroupIds.has(optionGroupName)) {
            usedOptionGroupIds.set(optionGroupName, `optionGroup${++optionGroupCount}`);
            optionGroupId = usedOptionGroupIds.get(optionGroupName);
            const optionGroupMin = option.min_selections || 0;
            const optionGroupMax = option.max_selections || 0;
            const optionGroupEachMax = optionGroupType === 'counter' ? 10 : 1;
            const optionIds = [];
            for (const value of option.values) {
              const price = (value.price / 100).toFixed(2) || '0.00';
              const optionName = normalizeText(value.name || '');
              if (!optionName) continue;
              const optionKey = `${optionName}:${price}`;
              const isFree = parseFloat(price) === 0;
              let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
              if (usedOptionIds.has(optionKey)) {
                optionId = usedOptionIds.get(optionKey);
                if (!optionIds.includes(optionId)) {
                  optionIds.push(optionId);
                }
                continue;
              }
              usedOptionIds.set(optionKey, optionId);
              optionsList.push({
                optionId: optionId,
                price: price,
                name: optionName,
                translatedItemName: '',
                optionGroups: optionGroupId,
                extrasId: value.id || '',
                isFree: isFree
              });
              optionIds.push(optionId);
              optionCount++;
            }
            if (optionIds.length > 0) {
              optionGroups.push({
                optionGroupId: optionGroupId,
                name: optionGroupName,
                nameEnUS: '',
                optionGroupType: optionGroupType,
                optionGroupMin: optionGroupMin,
                optionGroupMax: optionGroupMax,
                optionGroupEachMax: optionGroupEachMax,
                dishUrl: `${menuUrl}${itemId}`,
                options: [...new Set(optionIds)],
                dishes: [dishId]
              });
              dishOptionGroupIds.push(optionGroupId);
              itemOptions.set(optionGroupName, { optionGroupId, optionIds });
            }
          } else {
            optionGroupId = usedOptionGroupIds.get(optionGroupName);
            const existingOptionGroup = optionGroups.find(og => og.optionGroupId === optionGroupId);
            if (existingOptionGroup && !existingOptionGroup.dishes.includes(dishId)) {
              existingOptionGroup.dishes.push(dishId);
              dishOptionGroupIds.push(optionGroupId);
              const optionIds = itemOptions.get(optionGroupName)?.optionIds || [];
              for (const value of option.values) {
                const price = (value.price / 100).toFixed(2) || '0.00';
                const optionName = normalizeText(value.name || '');
                if (!optionName) continue;
                const optionKey = `${optionName}:${price}`;
                const isFree = parseFloat(price) === 0;
                let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                if (usedOptionIds.has(optionKey)) {
                  optionId = usedOptionIds.get(optionKey);
                  if (!optionIds.includes(optionId) && !existingOptionGroup.options.includes(optionId)) {
                    optionIds.push(optionId);
                    existingOptionGroup.options.push(optionId);
                  }
                  continue;
                }
                usedOptionIds.set(optionKey, optionId);
                optionsList.push({
                  optionId: optionId,
                  price: price,
                  name: optionName,
                  translatedItemName: '',
                  optionGroups: optionGroupId,
                  extrasId: value.id || '',
                  isFree: isFree
                });
                optionIds.push(optionId);
                existingOptionGroup.options.push(optionId);
                optionCount++;
              }
              existingOptionGroup.options = [...new Set(existingOptionGroup.options)];
              itemOptions.set(optionGroupName, { optionGroupId, optionIds });
            }
          }
        }
      }
      dishes.find(d => d.id === dishId).optionGroups = dishOptionGroupIds.join(', ');
    }
  
    // 7) Clean up toResize/ images
    if (s3KeysToDelete.length > 0) {
      await cleanS3ToResize(restaurantName, s3KeysToDelete);
    }
  
    // 8) Log contents of /tmp/output/<restaurantName>/pics after processing
    try {
      const imageFiles = await fs.readdir(outputDir).catch(() => []);
      console.log(`Images in ${outputDir} after processing: ${imageFiles.join(', ')}`);
    } catch (error) {
      console.error(`Failed to list images in ${outputDir}: ${error.message}`);
    }
  
    // 9) Add delay to ensure S3 operations are complete
    console.log('Waiting 2 seconds to ensure S3 operations are complete...');
    await delay(2000);
  
    // 10) Log contents again before CSV writing
    try {
      const imageFiles = await fs.readdir(outputDir).catch(() => []);
      console.log(`Images in ${outputDir} before CSV writing: ${imageFiles.join(', ')}`);
    } catch (error) {
      console.error(`Failed to list images in ${outputDir} before CSV writing: ${error.message}`);
    }
  
    // 11) Log extraction results
    console.log(`Extracted ${dishes.length} dishes, ${categorySet.size} categories, ${imageCount} images, ${optionCount} options, ${optionGroupCount} option groups, ${tagCount} tags`);
    if (dishes.length > 0) console.log('Sample dish:', dishes[0]);
    if (optionGroups.length > 0) console.log('Sample option group:', optionGroups[0]);
    if (optionsList.length > 0) console.log('Sample option:', optionsList[0]);
  
    // 12) Save raw JSON
    const rawData = { dishes, options: optionsList, optionGroups };
    await fs.writeFile(path.join('/tmp', 'output', `${restaurantName}_raw.json`), JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`Raw JSON saved: /tmp/output/${restaurantName}_raw.json`);
  
    return {
      dishes,
      options: optionsList,
      optionGroups,
      startTime: Date.now(),
      counters: {
        dishes: dishes.length,
        categories: categorySet.size,
        images: imageCount,
        options: optionCount,
        optionGroups: optionGroupCount,
        tags: tagCount
      }
    };
  }
  
async function scrapeUberEats(page, restaurantUrl, restaurantName) {
    console.log('Scraping Uber Eats via getStoreV1 or getCatalogPresentationV2 (browser context)...');
    const outputDir = path.join('/tmp', 'output', restaurantName, 'pics');
    await ensureOutputDir(outputDir);

    // Clear the /tmp/output/<restaurantName>/pics directory
    console.log(`Clearing directory ${outputDir}`);
    try {
        await fs.rm(outputDir, { recursive: true, force: true });
        console.log(`Cleared directory ${outputDir}`);
        await ensureOutputDir(outputDir);
    } catch (error) {
        console.error(`Failed to clear directory ${outputDir}: ${error.message}`);
    }

    // Log contents of /tmp/output before starting
    try {
        const tmpFiles = await fs.readdir(path.join('/tmp', 'output')).catch(() => []);
        console.log(`Contents of /tmp/output: ${tmpFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list /tmp/output contents: ${error.message}`);
    }

    // Check for online shop format using URL regex
    console.log('Checking for online shop format...');
    const isOnlineShop = await page.evaluate(async (restaurantUrl) => {
        const scatsRegex = /^https?:\/\/(?:www\.)?ubereats\.com\/[a-z]{2}(?:-[A-Z]{2})?\/store\/[^\/?#]+\/[A-Za-z0-9_-]+(?:\/[^?#]+)?\?(?:[^#]*&)?scats=[0-9a-f-]{36}(?:&[^#]*)?$/;
        const uuidPathRegex = /\/store\/[^\/?#]+\/[A-Za-z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
        const hasScats = scatsRegex.test(restaurantUrl) || /scats=/.test(restaurantUrl) || /scatsubs=/.test(restaurantUrl);
        const hasUuidPath = uuidPathRegex.test(restaurantUrl);
        const anchors = Array.from(document.querySelectorAll('a[href*="//www.ubereats.com/"][href*="/store/"]')).filter(a => /scats=/.test(a.href) || /scatsubs=/.test(a.href));
        return hasScats || hasUuidPath || anchors.length > 0;
    }, restaurantUrl);
    console.log(`Detected format: ${isOnlineShop ? 'Online Shop' : 'Restaurant'}`);

    // Navigate to the store page to capture cookies
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36');
    console.log(`Navigating to ${restaurantUrl}`);
    try {
        await page.goto(restaurantUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (error) {
        console.error(`Failed to navigate to ${restaurantUrl}: ${error.message}`);
        throw error;
    }

    const dishes = [];
    const optionsList = [];
    const optionGroups = [];
    const usedIds = new Set();
    const usedOptionIds = new Map();
    const usedOptionGroupIds = new Map();
    let imageCount = 0;
    let optionCount = 0;
    let optionGroupCount = 0;
    let tagCount = 0;
    const menuUrl = restaurantUrl.endsWith('/') ? restaurantUrl : `${restaurantUrl}/`;
    const s3KeysToDelete = []; // Track toResize/ images for cleanup

    if (isOnlineShop) {
        // Online Shop Format
        console.log('Scraping Uber Eats Online Shop format...');
        const storeData = await page.evaluate(async () => {
            const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
            const getLocales = () => {
                const seg = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
                const base = /^[a-z]{2}(-[a-z]{2})?$/.test(seg) ? seg : 'pl';
                return [base, `${base}-en`].filter((v, i, a) => a.indexOf(v) === i);
            };
            const getStoreUuidCandidates = () => {
                const segs = location.pathname.split('/').filter(Boolean);
                const fromPath = segs.find(s => /^[0-9a-f-]{36}$/i.test(s));
                const list = new Set();
                if (fromPath) list.add(fromPath);
                const html = document.documentElement.innerHTML;
                for (const m of html.matchAll(uuidRe)) list.add(m[0]);
                return Array.from(list);
            };
            const HEADERS = (locale) => ({
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json;charset=UTF-8',
                'x-csrf-token': 'x',
                'x-fusion-locale-code': locale
            });
            async function validateStoreUuid(uuid, locales) {
                for (const lc of locales) {
                    try {
                        const url = new URL('https://www.ubereats.com/_p/api/getStoreV1');
                        url.searchParams.set('localeCode', lc);
                        const res = await fetch(url, {
                            method: 'POST',
                            headers: HEADERS(lc),
                            credentials: 'include',
                            body: JSON.stringify({
                                storeUuid: uuid,
                                diningMode: 'DELIVERY',
                                time: { asap: true },
                                cbType: 'EATER_ENDORSED'
                            })
                        });
                        const js = await res.json();
                        const ok = res.ok && js?.status !== 'failure';
                        const hasSections = js?.data?.catalogSectionsMap || js?.data?.menu?.catalogSectionsMap;
                        if (ok && hasSections) {
                            return { storeUuid: uuid, locale: lc, storeJs: js };
                        }
                    } catch {}
                }
                return null;
            }
            function buildDiscoverBody(variant, storeUuid) {
                const pagingInfo = { enabled: true, offset: null };
                const common = { sortAndFilters: null, source: 'NV_L2_CATALOG' };
                return (variant === 'storeFilters') ? {
                    storeFilters: { storeUuid, sectionUuids: [], subsectionUuids: null, shouldReturnSegmentedControlData: true },
                    pagingInfo, ...common
                } : { storeUuid, sectionUuids: [], shouldReturnSegmentedControlData: true, pagingInfo, ...common };
            }
            async function getPresentationAny(storeUuid, locales) {
                const VARIANTS = ['storeFilters', 'topLevel'];
                for (const lc of locales) {
                    for (const variant of VARIANTS) {
                        try {
                            const url = new URL('https://www.ubereats.com/_p/api/getCatalogPresentationV2');
                            url.searchParams.set('localeCode', lc);
                            const res = await fetch(url, {
                                method: 'POST',
                                headers: HEADERS(lc),
                                credentials: 'include',
                                body: JSON.stringify(buildDiscoverBody(variant, storeUuid))
                            });
                            const js = await res.json();
                            if (res.ok && js?.status !== 'failure') {
                                return { js, locale: lc, variant };
                            }
                        } catch {}
                    }
                }
                return null;
            }
            function collectSectionsFromPresentation(data) {
                const out = new Map();
                const add = (uuid, title) => {
                    if (!uuid || !/^[0-9a-f-]{36}$/i.test(String(uuid))) return;
                    if (!out.has(uuid)) out.set(uuid, title || null);
                };
                (data?.sections || []).forEach(s => add(s.uuid, s.title));
                (data?.segmentedControlData?.segmentedControlItems || []).forEach(i => add(i.categoryUuid, i.title));
                (data?.catalog || []).forEach(sec => {
                    const std = sec?.payload?.standardItemsPayload;
                    add(sec?.catalogSectionUUID, std?.title?.text);
                    (std?.catalogItems || []).forEach(it => {
                        add(it?.sectionUuid, std?.title?.text);
                        add(it?.subsectionUuid, std?.title?.text);
                    });
                });
                return Array.from(out, ([uuid, title]) => ({ uuid, title }));
            }
            function collectSectionsFromStoreV1(js) {
                const out = new Map();
                const add = (uuid, title) => {
                    if (!uuid || !/^[0-9a-f-]{36}$/i.test(String(uuid))) return;
                    if (!out.has(uuid)) out.set(uuid, title || null);
                };
                const maps = [js?.data?.catalogSectionsMap, js?.data?.menu?.catalogSectionsMap].filter(Boolean);
                for (const m of maps) {
                    for (const arr of Object.values(m)) {
                        for (const sec of (arr || [])) {
                            const std = sec?.payload?.standardItemsPayload;
                            add(sec?.uuid, std?.title?.text || sec?.title?.text || sec?.title);
                            (std?.catalogItems || []).forEach(it => {
                                add(it?.sectionUuid, std?.title?.text);
                                add(it?.subsectionUuid, std?.title?.text);
                            });
                        }
                    }
                }
                return Array.from(out, ([uuid, title]) => ({ uuid, title }));
            }
            const LOCALES = getLocales();
            const candidates = getStoreUuidCandidates();
            if (!candidates.length) throw new Error('No UUIDs found on page');
            let validated = null;
            for (const cand of candidates) {
                validated = await validateStoreUuid(cand, LOCALES);
                if (validated) break;
            }
            if (!validated) throw new Error('No valid storeUuid found');
            const { storeUuid, locale: validatedLocale, storeJs } = validated;
            let sections = [];
            const pres = await getPresentationAny(storeUuid, LOCALES);
            if (pres) {
                sections = collectSectionsFromPresentation(pres.js?.data);
            }
            if (!sections.length) {
                sections = collectSectionsFromStoreV1(storeJs);
            }
            return { storeUuid, locale: validatedLocale, sectionUuids: sections.map(s => s.uuid), sections };
        });

        console.log(`Online Shop: storeUuid: ${storeData.storeUuid}, locale: ${storeData.locale}, total sections: ${storeData.sectionUuids.length}`);

        const allItems = await page.evaluate(async ({ storeUuid, sectionUuids, locale }) => {
            const LOCALES = [locale, `${locale}-en`, 'pt', 'pt-en'].filter((v, i, a) => !!v && a.indexOf(v) === i);
            const SOURCES = ['NV_L2_CATALOG', 'NV_L1_CATALOG'];
            const VARIANTS = ['storeFilters', 'topLevel'];
            const HEADERS = {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json;charset=UTF-8',
                'x-csrf-token': 'x',
            };
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            function buildBody(variant, source, sectionUuid, offset) {
                const pagingInfo = { enabled: true, offset };
                const common = { sortAndFilters: null, source };
                if (variant === 'storeFilters') {
                    return {
                        storeFilters: {
                            storeUuid,
                            sectionUuids: [sectionUuid],
                            subsectionUuids: null,
                            shouldReturnSegmentedControlData: false
                        },
                        pagingInfo, ...common
                    };
                }
                return {
                    storeUuid,
                    sectionUuids: [sectionUuid],
                    shouldReturnSegmentedControlData: false,
                    pagingInfo, ...common
                };
            }
            async function callPresentation(locale, variant, source, sectionUuid, offset) {
                const url = new URL('https://www.ubereats.com/_p/api/getCatalogPresentationV2');
                url.searchParams.set('localeCode', locale);
                const res = await fetch(url.toString(), {
                    method: 'POST',
                    headers: HEADERS,
                    credentials: 'include',
                    body: JSON.stringify(buildBody(variant, source, sectionUuid, offset))
                });
                let json; try { json = await res.json(); } catch {}
                if (!res.ok || json?.status === 'failure') {
                    const msg = json?.data?.message || json?.data?.code || `HTTP ${res.status}`;
                    throw new Error(msg);
                }
                return json;
            }
            function extractItems(json) {
                const out = [];
                const catalog = json?.data?.catalog || [];
                for (const sec of catalog) {
                    const std = sec?.payload?.standardItemsPayload;
                    if (!std) continue;
                    const sectionTitle = std?.title?.text || std?.title || null;
                    for (const it of (std.catalogItems || [])) {
                        const cents = typeof it?.price === 'number' ? it.price : null;
                        let amount = cents != null ? (cents / 100) : null;
                        if (amount == null) {
                            const pp = it?.purchaseInfo?.purchaseOptions?.[0]?.purchasePriceV2;
                            if (pp) {
                                if (pp.base && typeof pp.base.low === 'number' && typeof pp.exponent === 'number') {
                                    amount = pp.base.low * Math.pow(10, pp.exponent);
                                } else if (typeof pp.units === 'number' && typeof pp.nanos === 'number') {
                                    amount = pp.units + pp.nanos / 1e9;
                                }
                            }
                        }
                        const img = it?.imageUrl || it?.image?.url || it?.image?.imageUrl || null;
                        out.push({
                            category: sectionTitle || null,
                            name: it?.title || '',
                            price: amount ? amount.toFixed(2) : '0.00',
                            description: it?.description || '',
                            uuid: it?.uuid || '',
                            sectionUuid: it?.sectionUuid || '',
                            subsectionUuid: it?.subsectionUuid || '',
                            imageUrl: img,
                            hasCustomizations: false // Online shop items typically don't have customizations
                        });
                    }
                }
                return out;
            }
            function findNextOffset(payload) {
                let found = null;
                (function visit(o) {
                    if (!o || typeof o !== 'object') return;
                    if (o.pageInfo && o.pageInfo.nextOffset != null) found = o.pageInfo.nextOffset;
                    for (const v of Object.values(o)) visit(v);
                })(payload);
                return found;
            }
            async function fetchCategoryAllPages(sectionUuid) {
                const collected = [];
                const seen = new Set();
                const triedOffsets = new Set();
                let offset = 0;
                let emptyStreak = 0;
                let pages = 0;
                while (true) {
                    let page = null, ok = false, lastErr = null;
                    for (const locale of LOCALES) {
                        for (const source of SOURCES) {
                            for (const variant of VARIANTS) {
                                try {
                                    page = await callPresentation(locale, variant, source, sectionUuid, offset);
                                    ok = true; break;
                                } catch (e) { lastErr = e; }
                            }
                            if (ok) break;
                        }
                        if (ok) break;
                    }
                    if (!ok) {
                        console.warn(`Category ${sectionUuid}: failed at offset ${offset}:`, lastErr?.message);
                        break;
                    }
                    const items = extractItems(page);
                    let addedThisPage = 0;
                    for (const it of items) {
                        const key = `${it.name}::${it.category ?? ''}::${it.price ?? 'na'}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        collected.push(it);
                        addedThisPage++;
                    }
                    pages++;
                    const next = findNextOffset(page?.data);
                    if (next != null) {
                        if (triedOffsets.has(next) || next === offset) break;
                        triedOffsets.add(next);
                        offset = next;
                    } else {
                        if (addedThisPage === 0) {
                            emptyStreak++;
                            if (emptyStreak >= 2) break;
                        } else {
                            emptyStreak = 0;
                        }
                        offset += 50;
                    }
                    await sleep(120 + Math.random() * 180);
                    if (pages >= 200) break;
                }
                return collected;
            }
            const all = [];
            const globalSeen = new Set();
            for (const cat of sectionUuids) {
                console.log('Category', cat, '…');
                const batch = await fetchCategoryAllPages(cat);
                console.log(' →', batch.length, 'items (filtered fields only)');
                for (const it of batch) {
                    const key = `${it.name}::${it.category ?? ''}::${it.price ?? 'na'}`;
                    if (globalSeen.has(key)) continue;
                    globalSeen.add(key);
                    all.push(it);
                }
            }
            console.log('TOTAL unique items:', all.length);
            return all;
        }, { storeUuid: storeData.storeUuid, sectionUuids: storeData.sectionUuids, locale: storeData.locale });

        console.log(`Fetched ${allItems.length} items from Uber Eats Online Shop`);

        for (const item of allItems) {
            const name = normalizeText(item.name || '');
            if (!name) {
                console.warn(`Skipping item with empty name: ${JSON.stringify(item)}`);
                continue;
            }

            const dishId = generateDishId(name, usedIds);
            const categoryName = normalizeText(item.category || 'Unknown Category');
            const tags = assignTags(name);
            tagCount += tags.length;

            // Image handling
            let imagePath = '';
            let imageAttachment = [];
            const imageUrl = item.imageUrl || '';
            if (imageUrl) {
                console.log(`Image URL for ${name}: ${imageUrl}`);
                const safeName = sanitizeFilename(name, true);
                const uniqueId = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
                const maxBaseLength = 50 - (uniqueId.length + 5);
                const finalBaseName = safeName.substring(0, maxBaseLength);
                const localFilePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
                try {
                    const downloadResult = await downloadImage(restaurantUrl, imageUrl, localFilePath, restaurantName, name);
                    if (downloadResult && fsSync.existsSync(localFilePath)) {
                        s3KeysToDelete.push(downloadResult.s3Key);
                        const resizeResult = await resizeImage(downloadResult.s3Key, localFilePath, restaurantName, name);
                        if (resizeResult) {
                            imagePath = resizeResult.url;
                            imageAttachment = [{ url: resizeResult.url, filename: resizeResult.filename }];
                            imageCount++;
                            console.log(`Image processed for ${name}: ${resizeResult.url}`);
                        } else {
                            console.warn(`Failed to resize image for ${name} from s3://synapseimage/${downloadResult.s3Key}`);
                        }
                    } else {
                        console.warn(`Image download failed for ${name}: ${localFilePath}`);
                    }
                } catch (err) {
                    console.error(`Failed to process image for ${name}: ${err.message}`);
                    await fs.unlink(localFilePath).catch(() => {});
                }
            } else {
                console.log(`No image URL for ${name}`);
            }

            dishes.push({
                id: dishId,
                category: categoryName,
                dishName: name,
                price: cleanPrice(item.price),
                description: normalizeText(item.description || ''),
                image: imagePath,
                optionGroups: '',
                tags: tags,
                imageAttachment
            });
        }
    } else {
        // Restaurant Format
        console.log('Scraping Uber Eats Restaurant format...');
        const storeUuid = await page.evaluate(async () => {
            const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
            const getLocales = () => {
                const seg = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
                const base = /^[a-z]{2}(-[a-z]{2})?$/.test(seg) ? seg : 'pl';
                return [base, `${base}-en`].filter((v, i, a) => a.indexOf(v) === i);
            };
            const getStoreUuidCandidates = () => {
                const segs = location.pathname.split('/').filter(Boolean);
                const fromPath = segs.find(s => /^[0-9a-f-]{36}$/i.test(s));
                const list = new Set();
                if (fromPath) list.add(fromPath);
                const html = document.documentElement.innerHTML;
                for (const m of html.matchAll(uuidRe)) list.add(m[0]);
                console.log(`Found UUID candidates: ${Array.from(list).join(', ')}`);
                return Array.from(list);
            };
            const HEADERS = (locale) => ({
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json;charset=UTF-8',
                'x-csrf-token': 'x',
                'x-fusion-locale-code': locale
            });
            async function validateStoreUuid(uuid, locales) {
                for (const lc of locales) {
                    try {
                        const url = new URL('https://www.ubereats.com/_p/api/getStoreV1');
                        url.searchParams.set('localeCode', lc);
                        console.log(`Validating UUID ${uuid} with locale ${lc}`);
                        const res = await fetch(url, {
                            method: 'POST',
                            headers: HEADERS(lc),
                            credentials: 'include',
                            body: JSON.stringify({
                                storeUuid: uuid,
                                diningMode: 'DELIVERY',
                                time: { asap: true },
                                cbType: 'EATER_ENDORSED'
                            })
                        });
                        const js = await res.json();
                        if (res.ok && js?.status !== 'failure') {
                            console.log(`Valid UUID found: ${uuid}`);
                            return uuid;
                        } else {
                            console.log(`UUID ${uuid} invalid for locale ${lc}: ${js?.status || 'unknown error'}`);
                        }
                    } catch (error) {
                        console.error(`Error validating UUID ${uuid} for locale ${lc}: ${error.message}`);
                    }
                }
                return null;
            }
            const LOCALES = getLocales();
            console.log(`Locales for UUID validation: ${LOCALES.join(', ')}`);
            const candidates = getStoreUuidCandidates();
            if (!candidates.length) throw new Error('No UUIDs found on page');
            let storeUuid = null;
            for (const cand of candidates) {
                storeUuid = await validateStoreUuid(cand, LOCALES);
                if (storeUuid) break;
            }
            if (!storeUuid) throw new Error('No valid storeUuid found');
            return storeUuid;
        });

        console.log(`Extracted storeUuid: ${storeUuid}`);

        const allItems = await page.evaluate(async ({ storeUuid }) => {
            const HEADERS = {
                'accept': '*/*',
                'content-type': 'application/json',
                'x-csrf-token': 'x',
                'x-uber-client-gitref': '497cd8dec9cbfbf9ea87736ae36b92082e8b5967'
            };
            async function fetchStore(storeUuid) {
                const url = "https://www.ubereats.com/api/getStoreV1?localeCode=pl-PL";
                console.log(`Fetching store data for UUID ${storeUuid}`);
                const response = await fetch(url, {
                    method: "POST",
                    headers: HEADERS,
                    credentials: "include",
                    body: JSON.stringify({ storeUuid })
                });
                const data = await response.json();
                if (!response.ok || data?.status === 'failure') {
                    throw new Error(`Failed to fetch store data: ${data?.message || 'Unknown error'}`);
                }
                console.log(`Store data fetched successfully for UUID ${storeUuid}`);
                return data.data;
            }
            async function fetchMenuItem(storeUuid, menuItemUuid, sectionUuid, subsectionUuid) {
                const url = "https://www.ubereats.com/api/getMenuItemV1?localeCode=pl-PL";
                console.log(`Fetching menu item ${menuItemUuid} for section ${sectionUuid}, subsection ${subsectionUuid}`);
                const response = await fetch(url, {
                    method: "POST",
                    headers: HEADERS,
                    credentials: "include",
                    body: JSON.stringify({
                        storeUuid,
                        menuItemUuid,
                        sectionUuid,
                        subsectionUuid,
                        diningMode: "DELIVERY",
                        time: { asap: true },
                        localeCode: "pl-PL"
                    })
                });
                const data = await response.json();
                if (!response.ok || data?.status === 'failure') {
                    console.warn(`Failed to fetch menu item ${menuItemUuid}: ${data?.message || 'Unknown error'}`);
                    return null;
                }
                return data.data;
            }
            async function combineStoreWithItems(storeUuid) {
                try {
                    const storeData = await fetchStore(storeUuid);
                    const catalogSectionsMap = storeData.catalogSectionsMap || {};
                    const combinedItems = [];
                    const seen = new Set();
                    for (const sectionId in catalogSectionsMap) {
                        const sectionArray = catalogSectionsMap[sectionId] || [];
                        for (const section of sectionArray) {
                            const std = section?.payload?.standardItemsPayload;
                            if (!std) continue;
                            const sectionTitle = std.title ? std.title.text : 'Unknown Category';
                            const catalogItems = std.catalogItems || [];
                            for (const item of catalogItems) {
                                const {
                                    title: itemName,
                                    itemDescription,
                                    priceTagline,
                                    uuid: menuItemUuid,
                                    sectionUuid,
                                    subsectionUuid,
                                    imageUrl,
                                    hasCustomizations,
                                    price
                                } = item;
                                if (!menuItemUuid || seen.has(menuItemUuid)) continue;
                                seen.add(menuItemUuid);
                                let customizations = [];
                                if (hasCustomizations) {
                                    const menuItemData = await fetchMenuItem(storeUuid, menuItemUuid, sectionUuid, subsectionUuid);
                                    if (menuItemData?.customizationsList) {
                                        customizations = menuItemData.customizationsList.map(c => ({
                                            title: c.title || 'Unknown Customization',
                                            options: (c.options || []).map(o => ({
                                                title: o.title || 'Unknown Option',
                                                price: typeof o.price === 'number' ? (o.price / 100).toFixed(2) : '0.00',
                                                subtitle: o.subtitle || '',
                                                id: o.uuid || ''
                                            })),
                                            minSelections: c.minSelections || 0,
                                            maxSelections: c.maxSelections || 0
                                        }));
                                    }
                                }
                                combinedItems.push({
                                    category: sectionTitle,
                                    name: itemName || 'Unknown Name',
                                    price: priceTagline ? priceTagline.text : (typeof price === 'number' ? (price / 100).toFixed(2) : '0.00'),
                                    description: itemDescription || '',
                                    uuid: menuItemUuid,
                                    sectionUuid: sectionUuid || '',
                                    subsectionUuid: subsectionUuid || '',
                                    imageUrl: imageUrl || '',
                                    customizations
                                });
                            }
                        }
                    }
                    console.log(`Fetched ${combinedItems.length} unique items`);
                    return combinedItems;
                } catch (error) {
                    console.error(`Error fetching data: ${error.message}`);
                    throw error;
                }
            }
            return await combineStoreWithItems(storeUuid);
        }, { storeUuid });

        console.log(`Fetched ${allItems.length} items from Uber Eats Restaurant`);

        for (const item of allItems) {
            const name = normalizeText(item.name || '');
            if (!name) {
                console.warn(`Skipping item with empty name: ${JSON.stringify(item)}`);
                continue;
            }

            const dishId = generateDishId(name, usedIds);
            const categoryName = normalizeText(item.category || 'Unknown Category');
            const tags = assignTags(name);
            tagCount += tags.length;

            // Image handling
            let imagePath = '';
            let imageAttachment = [];
            const imageUrl = item.imageUrl || '';
            if (imageUrl) {
                console.log(`Image URL for ${name}: ${imageUrl}`);
                const safeName = sanitizeFilename(name, true);
                const uniqueId = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
                const maxBaseLength = 50 - (uniqueId.length + 5);
                const finalBaseName = safeName.substring(0, maxBaseLength);
                const localFilePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
                try {
                    const downloadResult = await downloadImage(restaurantUrl, imageUrl, localFilePath, restaurantName, name);
                    if (downloadResult && fsSync.existsSync(localFilePath)) {
                        s3KeysToDelete.push(downloadResult.s3Key);
                        const resizeResult = await resizeImage(downloadResult.s3Key, localFilePath, restaurantName, name);
                        if (resizeResult) {
                            imagePath = resizeResult.url;
                            imageAttachment = [{ url: resizeResult.url, filename: resizeResult.filename }];
                            imageCount++;
                            console.log(`Image processed for ${name}: ${resizeResult.url}`);
                        } else {
                            console.warn(`Failed to resize image for ${name} from s3://synapseimage/${downloadResult.s3Key}`);
                        }
                    } else {
                        console.warn(`Image download failed for ${name}: ${localFilePath}`);
                    }
                } catch (err) {
                    console.error(`Failed to process image for ${name}: ${err.message}`);
                    await fs.unlink(localFilePath).catch(() => {});
                }
            } else {
                console.log(`No image URL for ${name}`);
            }

            const dishOptionGroupIds = [];
            dishes.push({
                id: dishId,
                category: categoryName,
                dishName: name,
                price: cleanPrice(item.price),
                description: normalizeText(item.description || ''),
                image: imagePath,
                optionGroups: '',
                tags: tags,
                imageAttachment
            });

            // Process customizations (only for restaurant format)
            for (const customization of item.customizations || []) {
                const optionGroupName = normalizeText(customization.title || '');
                if (!optionGroupName) {
                    console.warn(`Skipping customization with empty title for ${name}`);
                    continue;
                }
                const isCounterType = optionGroupName.toLowerCase().includes('sos') || optionGroupName.toLowerCase().includes('dodatki');
                const optionGroupType = isCounterType ? 'counter' : customization.maxSelections > 1 ? 'multi_select' : 'single_select';
                let optionGroupId;
                if (!usedOptionGroupIds.has(optionGroupName)) {
                    usedOptionGroupIds.set(optionGroupName, `optionGroup${++optionGroupCount}`);
                    optionGroupId = usedOptionGroupIds.get(optionGroupName);
                    const optionGroupMin = customization.minSelections || 0;
                    const optionGroupMax = customization.maxSelections || 0;
                    const optionGroupEachMax = optionGroupType === 'counter' ? 10 : 1;
                    const optionIds = [];
                    for (const option of customization.options || []) {
                        const price = cleanPrice(option.price || '0.00');
                        const optionName = normalizeText(option.title || '');
                        if (!optionName) {
                            console.warn(`Skipping option with empty title for ${optionGroupName}`);
                            continue;
                        }
                        const optionKey = `${optionName}:${price}`;
                        const isFree = parseFloat(price) === 0;
                        let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                        if (usedOptionIds.has(optionKey)) {
                            optionId = usedOptionIds.get(optionKey);
                            if (!optionIds.includes(optionId)) {
                                optionIds.push(optionId);
                            }
                            continue;
                        }
                        usedOptionIds.set(optionKey, optionId);
                        optionsList.push({
                            optionId: optionId,
                            price: price,
                            name: optionName,
                            translatedItemName: '',
                            optionGroups: optionGroupId,
                            extrasId: option.id || '',
                            isFree: isFree
                        });
                        optionIds.push(optionId);
                        optionCount++;
                    }
                    if (optionIds.length > 0) {
                        optionGroups.push({
                            optionGroupId: optionGroupId,
                            name: optionGroupName,
                            nameEnUS: '',
                            optionGroupType: optionGroupType,
                            optionGroupMin: optionGroupMin,
                            optionGroupMax: optionGroupMax,
                            optionGroupEachMax: optionGroupEachMax,
                            dishUrl: `${menuUrl}${item.uuid}`,
                            options: [...new Set(optionIds)],
                            dishes: [dishId]
                        });
                        dishOptionGroupIds.push(optionGroupId);
                    }
                } else {
                    optionGroupId = usedOptionGroupIds.get(optionGroupName);
                    const existingOptionGroup = optionGroups.find(og => og.optionGroupId === optionGroupId);
                    if (existingOptionGroup && !existingOptionGroup.dishes.includes(dishId)) {
                        existingOptionGroup.dishes.push(dishId);
                        dishOptionGroupIds.push(optionGroupId);
                        const optionIds = [];
                        for (const option of customization.options || []) {
                            const price = cleanPrice(option.price || '0.00');
                            const optionName = normalizeText(option.title || '');
                            if (!optionName) {
                                console.warn(`Skipping option with empty title for ${optionGroupName}`);
                                continue;
                            }
                            const optionKey = `${optionName}:${price}`;
                            const isFree = parseFloat(price) === 0;
                            let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                            if (usedOptionIds.has(optionKey)) {
                                optionId = usedOptionIds.get(optionKey);
                                if (!optionIds.includes(optionId) && !existingOptionGroup.options.includes(optionId)) {
                                    optionIds.push(optionId);
                                    existingOptionGroup.options.push(optionId);
                                }
                                continue;
                            }
                            usedOptionIds.set(optionKey, optionId);
                            optionsList.push({
                                optionId: optionId,
                                price: price,
                                name: optionName,
                                translatedItemName: '',
                                optionGroups: optionGroupId,
                                extrasId: option.id || '',
                                isFree: isFree
                            });
                            optionIds.push(optionId);
                            existingOptionGroup.options.push(optionId);
                            optionCount++;
                        }
                        existingOptionGroup.options = [...new Set(existingOptionGroup.options)];
                    }
                }
            }
            dishes.find(d => d.id === dishId).optionGroups = dishOptionGroupIds.join(', ');
        }
    }

    // Clean up toResize/ images
    if (s3KeysToDelete.length > 0) {
        await cleanS3ToResize(restaurantName, s3KeysToDelete);
    }

    // Log contents of /tmp/output/<restaurantName>/pics after processing
    try {
        const imageFiles = await fs.readdir(outputDir).catch(() => []);
        console.log(`Images in ${outputDir} after processing: ${imageFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list images in ${outputDir}: ${error.message}`);
    }

    // Add a delay to ensure all S3 operations are complete
    console.log('Waiting 2 seconds to ensure S3 operations are complete...');
    await delay(2000);

    // Log contents again before CSV writing
    try {
        const imageFiles = await fs.readdir(outputDir).catch(() => []);
        console.log(`Images in ${outputDir} before CSV writing: ${imageFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list images in ${outputDir} before CSV writing: ${error.message}`);
    }

    console.log(`Extracted ${dishes.length} dishes, ${new Set(dishes.map(d => d.category)).size} categories, ${imageCount} images, ${optionCount} options, ${optionGroupCount} option groups, ${tagCount} tags`);
    if (dishes.length > 0) console.log('Sample dish:', dishes[0]);
    if (optionGroups.length > 0) console.log('Sample option group:', optionGroups[0]);
    if (optionsList.length > 0) console.log('Sample option:', optionsList[0]);

    // Save raw JSON
    const rawData = { dishes, options: optionsList, optionGroups };
    await fs.writeFile(path.join('/tmp', 'output', `${restaurantName}_raw.json`), JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`Raw JSON saved: /tmp/output/${restaurantName}_raw.json`);

    return {
        dishes,
        options: optionsList,
        optionGroups,
        startTime: Date.now(),
        counters: {
            dishes: dishes.length,
            categories: new Set(dishes.map(d => d.category)).size,
            images: imageCount,
            options: optionCount,
            optionGroups: optionGroupCount,
            tags: tagCount
        }
    };
}
async function cleanS3ToResize(restaurantName, s3Keys) {
    const bucketName = 'synapseimage';
    console.log(`Cleaning S3 toResize folder for ${restaurantName}: ${s3Keys.length} files`);
    try {
        const deleteParams = {
            Bucket: bucketName,
            Delete: {
                Objects: s3Keys.map(key => ({ Key: key })),
                Quiet: false
            }
        };
        await s3.deleteObjects(deleteParams).promise();
        console.log(`Successfully deleted ${s3Keys.length} files from s3://synapseimage/toResize/${restaurantName}`);
    } catch (error) {
        console.error(`Failed to clean S3 toResize folder: ${error.message}`);
    }
}

async function scrapeTazz(page, restaurantUrl, restaurantName) {
    console.log('Scraping Tazz.ro...');
    const outputDir = path.join('/tmp', 'output', restaurantName, 'pics');
    await ensureOutputDir(outputDir);
    await page.goto(restaurantUrl, { waitUntil: 'networkidle2' });
    try {
        await page.waitForSelector('.cm-btn.cm-btn-success', { timeout: 10000 });
        await page.click('.cm-btn.cm-btn-success');
        console.log('Cookies accepted.');
        await delay(2000);
    } catch (e) {
        console.log('Cookies popup not found:', e.message);
    }
    await delay(10000);
    console.log('Scrolling to load all menu items...');
    let scrollAttempts = 0;
    const maxScrollAttempts = 3;
    while (scrollAttempts < maxScrollAttempts) {
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 100;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 200);
                });
            });
            console.log('Scrolling completed successfully');
            break;
        } catch (error) {
            scrollAttempts++;
            console.warn(`Scroll attempt ${scrollAttempts} failed: ${error.message}`);
            if (scrollAttempts === maxScrollAttempts) {
                console.error(`Failed to scroll after ${maxScrollAttempts} attempts: ${error.message}`);
                throw error;
            }
            await delay(2000);
        }
    }
    await delay(5000);
    console.log('Extracting menu data...');
    const rawMenuData = await page.evaluate(() => {
        const basicNormalize = (text) => (text ? text.trim() : '');
        const categoryContainers = document.querySelectorAll('.partnersListLayout');
        const data = [];
        categoryContainers.forEach((container) => {
            const category = basicNormalize(container.querySelector('.widget-title')?.textContent || 'Unknown Category');
            const dishNodes = container.querySelectorAll('.restaurant-product-card');
            dishNodes.forEach((dishNode) => {
                const dishName = basicNormalize(dishNode.querySelector('.title-container')?.textContent || '');
                let priceRaw = '';
                const priceContainerGenius = dishNode.querySelector('.price-container-genius');
                if (priceContainerGenius) {
                    const priceOld = priceContainerGenius.querySelector('.product-price-old')?.textContent.trim() || '';
                    const pricePromo = priceContainerGenius.querySelector('.product-price.promo')?.textContent.trim() || '';
                    priceRaw = priceOld || pricePromo;
                } else {
                    const priceContainerZ = dishNode.querySelector('.price-container.zprice');
                    priceRaw = priceContainerZ?.textContent.trim() || '';
                }
                const description = basicNormalize(dishNode.querySelector('.description-container')?.textContent || '');
                const image = dishNode.querySelector('.image-container img')?.src || '';
                if (dishName) data.push({ category, dishName, price: priceRaw, description, image });
            });
        });
        return data;
    });
    const menuData = [];
    const usedIds = new Set();
    for (const item of rawMenuData) {
        let imagePath = '';
        if (item.image && item.image.startsWith('http')) {
            const safeName = sanitizeFilename(item.dishName);
            const uniqueId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            const maxBaseLength = 50 - (uniqueId.length + 5);
            const finalBaseName = safeName.substring(0, maxBaseLength);
            const filePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
            try {
                await downloadImage(restaurantUrl, item.image, filePath);
                await resizeImage(filePath);
                imagePath = path.join('pics', `${finalBaseName}-${uniqueId}.jpg`);
            } catch (error) {
                console.error(`Failed to process image for ${item.dishName}: ${error.message}`);
                await fs.unlink(filePath).catch(() => {});
            }
        }
        const dishId = generateDishId(item.dishName, usedIds);
        menuData.push({
            id: dishId,
            category: normalizeText(item.category),
            dishName: normalizeText(item.dishName),
            price: cleanPrice(item.price),
            description: normalizeText(item.description),
            image: imagePath,
            optionGroups: ''
        });
    }
    console.log(`Extracted ${menuData.length} dishes`);
    return { dishes: menuData, optionGroups: [], startTime: Date.now() };
}

async function scrapeFoody(page, restaurantUrl, restaurantName) {
    console.log('Scraping Foody.com via API...');
    const outputDir = path.join('/tmp', 'output', restaurantName, 'pics');
    await ensureOutputDir(outputDir);
    // Clear the output directory
    console.log(`Clearing directory ${outputDir}`);
    try {
        await fs.rm(outputDir, { recursive: true, force: true });
        console.log(`Cleared directory ${outputDir}`);
        await ensureOutputDir(outputDir);
    } catch (error) {
        console.error(`Failed to clear directory ${outputDir}: ${error.message}`);
    }
    // Log contents of /tmp/output
    try {
        const tmpFiles = await fs.readdir(path.join('/tmp', 'output')).catch(() => []);
        console.log(`Contents of /tmp/output: ${tmpFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list /tmp/output contents: ${error.message}`);
    }
    // Extract shop_id by intercepting network requests
    await page.setRequestInterception(true);
    let shopId = null;
    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('apinew.foody.com.cy/v3/shops/catalog')) {
            const urlObj = new URL(url);
            shopId = urlObj.searchParams.get('shop_id');
            console.log(`Extracted shop_id: ${shopId} from ${url}`);
        }
        request.continue();
    });
    // Navigate to the restaurant page to trigger the catalog request
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36');
    console.log(`Navigating to ${restaurantUrl}`);
    await page.goto(restaurantUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    // Wait for shop_id to be captured
    let attempts = 0;
    const maxAttempts = 10;
    while (!shopId && attempts < maxAttempts) {
        await delay(1000);
        attempts++;
    }
    if (!shopId) {
        throw new Error('Failed to extract shop_id from network requests');
    }
    page.off('request'); // Clean up request interception
    // Make API request
    const apiUrl = `https://apinew.foody.com.cy/v3/shops/catalog?shop_id=${shopId}`;
    console.log(`Fetching Foody API: ${apiUrl}`);
    const headers = {
        'accept': 'application/json',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
    };
    const maxRetries = 3;
    let apiResponse = null;
    const s3KeysToDelete = [];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(apiUrl, { headers });
            if (response.status === 200) {
                apiResponse = response.data;
                console.log('API response received:', JSON.stringify(apiResponse, null, 2));
                break;
            } else if (response.status === 429) {
                console.warn(`Rate limit hit on attempt ${attempt}, retrying after delay`);
                await delay(2000 * Math.pow(2, attempt - 1));
            } else {
                throw new Error(`API request failed with status ${response.status}`);
            }
        } catch (error) {
            console.error(`API attempt ${attempt} failed: ${error.message}`);
            if (attempt === maxRetries) {
                throw new Error(`Failed to fetch Foody API after ${maxRetries} attempts: ${error.message}`);
            }
            await delay(2000 * Math.pow(2, attempt - 1));
        }
    }
    if (!apiResponse) {
        throw new Error('Failed to retrieve Foody API data');
    }
    // Log response structure for debugging
    console.log('Response keys:', Object.keys(apiResponse || {}));
    if (apiResponse.data) {
        console.log('Data keys:', Object.keys(apiResponse.data));
        if (apiResponse.data.menu) {
            console.log('Menu keys:', Object.keys(apiResponse.data.menu));
        }
    }
    // Parse API response
    const menuUrl = restaurantUrl.endsWith('/') ? restaurantUrl : `${restaurantUrl}/`;
    const sections = apiResponse.data?.menu?.categories || apiResponse.categories || [];
    const items = sections.flatMap(section => section.items || []);
    const optionGroupsData = apiResponse.data?.menu?.option_groups || apiResponse.data?.optionGroups || apiResponse.optionGroups || {};
    const categoryMap = new Map();
    const categorySet = new Set();
    const dishes = [];
    const optionsList = [];
    const optionGroups = [];
    const usedIds = new Set();
    const usedOptionIds = new Map();
    const usedOptionGroupIds = new Map();
    let imageCount = 0;
    let optionCount = 0;
    let optionGroupCount = 0;
    // Extract categories
    for (const section of sections) {
        const categoryName = normalizeText(section.name || section.title || 'Unknown Category');
        categorySet.add(categoryName);
        const itemIds = (section.items || []).map(item => item.id || item.uuid || '');
        for (const itemId of itemIds) {
            categoryMap.set(itemId, categoryName);
        }
    }
    // Process items
    for (const item of items) {
        const itemId = item.id || item.uuid || '';
        const categoryName = categoryMap.get(itemId) || 'Unknown Category';
        const dishId = generateDishId(item.name || item.title, usedIds);
        let imagePath = '';
        let imageAttachment = [];
        const imageUrl = item.images?.menu || item.images?.original || item.image || item.imageUrl || '';
        if (imageUrl && imageUrl.startsWith('http')) {
            console.log(`Image URL for ${item.name || item.title}: ${imageUrl}`);
            const safeName = sanitizeFilename(item.name || item.title, true);
            const uniqueId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            const maxBaseLength = 50 - (uniqueId.length + 5);
            const finalBaseName = safeName.substring(0, maxBaseLength);
            const filePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
            try {
                const downloadResult = await downloadImage(restaurantUrl, imageUrl, filePath, restaurantName, item.name || item.title);
                if (downloadResult && fsSync.existsSync(filePath)) {
                    s3KeysToDelete.push(downloadResult.s3Key);
                    const resizeResult = await resizeImage(downloadResult.s3Key, filePath, restaurantName, item.name || item.title);
                    if (resizeResult) {
                        imagePath = resizeResult.url;
                        imageAttachment = [{ url: resizeResult.url, filename: resizeResult.filename }];
                        imageCount++;
                        console.log(`Image processed for ${item.name || item.title}: ${resizeResult.url}`);
                    } else {
                        console.warn(`Failed to resize image for ${item.name || item.title} from s3://synapseimage/${downloadResult.s3Key}`);
                    }
                } else {
                    console.warn(`Image download failed for ${item.name || item.title}: ${filePath}`);
                }
            } catch (error) {
                console.error(`Failed to process image for ${item.name || item.title}: ${error.message}`);
                await fs.unlink(filePath).catch(() => {});
            }
        } else {
            console.log(`No valid image URL for ${item.name || item.title}`);
        }
        const price = cleanPrice((item.price || item.full_price || 0).toFixed(2) || '0.00');
        const dishOptionGroupIds = [];
        dishes.push({
            id: dishId,
            category: categoryName,
            dishName: normalizeText(item.name || item.title || ''),
            price: price,
            description: normalizeText(item.description || ''),
            image: imagePath,
            optionGroups: '',
            imageAttachment
        });
        // Process customizations (options)
        const customizations = optionGroupsData[itemId]?.options || item.option_groups || item.extras || [];
        for (const customization of customizations) {
            const optionGroupName = normalizeText(customization.name || customization.title || '');
            if (!optionGroupName) continue;
            const isCounterType = optionGroupName.toLowerCase().includes('sos') || optionGroupName.toLowerCase().includes('dodatki');
            const optionGroupType = isCounterType ? 'counter' : 'multi_select';
            let optionGroupId;
            if (!usedOptionGroupIds.has(optionGroupName)) {
                usedOptionGroupIds.set(optionGroupName, `optionGroup${++optionGroupCount}`);
                optionGroupId = usedOptionGroupIds.get(optionGroupName);
                const optionGroupMin = customization.min || customization.minPermitted || 0;
                const optionGroupMax = customization.max || customization.maxPermitted || 0;
                const optionGroupEachMax = optionGroupType === 'counter' ? 10 : 1;
                const optionIds = [];
                const options = customization.options || customization.items || customization.extras || [];
                for (const option of options) {
                    const price = cleanPrice((option.price || option.priceInfo?.price || 0).toFixed(2) || '0.00');
                    const optionName = normalizeText(option.name || option.title || '');
                    if (!optionName) continue;
                    const optionKey = `${optionName}:${price}`;
                    const isFree = parseFloat(price) === 0;
                    let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                    if (usedOptionIds.has(optionKey)) {
                        optionId = usedOptionIds.get(optionKey);
                        if (!optionIds.includes(optionId)) {
                            optionIds.push(optionId);
                        }
                        continue;
                    }
                    usedOptionIds.set(optionKey, optionId);
                    optionsList.push({
                        optionId: optionId,
                        price: price,
                        name: optionName,
                        translatedItemName: '',
                        optionGroups: optionGroupId,
                        extrasId: option.id || option.uuid || '',
                        isFree: isFree
                    });
                    optionIds.push(optionId);
                    optionCount++;
                }
                if (optionIds.length > 0) {
                    optionGroups.push({
                        optionGroupId: optionGroupId,
                        name: optionGroupName,
                        nameEnUS: '',
                        optionGroupType: optionGroupType,
                        optionGroupMin: optionGroupMin,
                        optionGroupMax: optionGroupMax,
                        optionGroupEachMax: optionGroupEachMax,
                        dishUrl: `${menuUrl}${itemId}`,
                        options: [...new Set(optionIds)],
                        dishes: [dishId]
                    });
                    dishOptionGroupIds.push(optionGroupId);
                }
            } else {
                optionGroupId = usedOptionGroupIds.get(optionGroupName);
                const existingOptionGroup = optionGroups.find(og => og.optionGroupId === optionGroupId);
                if (existingOptionGroup && !existingOptionGroup.dishes.includes(dishId)) {
                    existingOptionGroup.dishes.push(dishId);
                    dishOptionGroupIds.push(optionGroupId);
                    const optionIds = [];
                    const options = customization.options || customization.items || customization.extras || [];
                    for (const option of options) {
                        const price = cleanPrice((option.price || option.priceInfo?.price || 0).toFixed(2) || '0.00');
                        const optionName = normalizeText(option.name || option.title || '');
                        if (!optionName) continue;
                        const optionKey = `${optionName}:${price}`;
                        const isFree = parseFloat(price) === 0;
                        let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                        if (usedOptionIds.has(optionKey)) {
                            optionId = usedOptionIds.get(optionKey);
                            if (!optionIds.includes(optionId) && !existingOptionGroup.options.includes(optionId)) {
                                optionIds.push(optionId);
                                existingOptionGroup.options.push(optionId);
                            }
                            continue;
                        }
                        usedOptionIds.set(optionKey, optionId);
                        optionsList.push({
                            optionId: optionId,
                            price: price,
                            name: optionName,
                            translatedItemName: '',
                            optionGroups: optionGroupId,
                            extrasId: option.id || option.uuid || '',
                            isFree: isFree
                        });
                        optionIds.push(optionId);
                        existingOptionGroup.options.push(optionId);
                        optionCount++;
                    }
                    existingOptionGroup.options = [...new Set(existingOptionGroup.options)];
                }
            }
        }
        dishes.find(d => d.id === dishId).optionGroups = dishOptionGroupIds.join(', ');
    }
    // Clean up toResize/ images
    if (s3KeysToDelete.length > 0) {
        await cleanS3ToResize(restaurantName, s3KeysToDelete);
    }
    // Log contents of /tmp/output/<restaurantName>/pics after processing
    try {
        const imageFiles = await fs.readdir(outputDir).catch(() => []);
        console.log(`Images in ${outputDir} after processing: ${imageFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list images in ${outputDir}: ${error.message}`);
    }
    // Add a delay to ensure all S3 operations are complete
    console.log('Waiting 2 seconds to ensure S3 operations are complete...');
    await delay(2000);
    // Log contents again before CSV writing
    try {
        const imageFiles = await fs.readdir(outputDir).catch(() => []);
        console.log(`Images in ${outputDir} before CSV writing: ${imageFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list images in ${outputDir} before CSV writing: ${error.message}`);
    }
    console.log(`Extracted ${dishes.length} dishes, ${categorySet.size} categories, ${imageCount} images, ${optionCount} options, ${optionGroupCount} option groups`);
    if (dishes.length > 0) console.log('Sample dish:', dishes[0]);
    if (optionGroups.length > 0) console.log('Sample option group:', optionGroups[0]);
    if (optionsList.length > 0) console.log('Sample option:', optionsList[0]);
    // Save raw JSON
    const rawData = { dishes, options: optionsList, optionGroups };
    await fs.writeFile(path.join('/tmp', 'output', `${restaurantName}_raw.json`), JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`Raw JSON saved: /tmp/output/${restaurantName}_raw.json`);
    return {
        dishes,
        options: optionsList,
        optionGroups,
        startTime: Date.now(),
        counters: {
            dishes: dishes.length,
            categories: categorySet.size,
            images: imageCount,
            options: optionCount,
            optionGroups: optionGroupCount,
            tags: 0
        }
    };
}

async function scrapeGlovo(page, restaurantUrl, restaurantName) {
    console.log('Scraping Glovoapp via API...');
    const outputDir = path.join('/tmp', 'output', restaurantName, 'pics');
    await ensureOutputDir(outputDir);

    // Clear the /tmp/output/<restaurantName>/pics directory
    console.log(`Clearing directory ${outputDir}`);
    try {
        await fs.rm(outputDir, { recursive: true, force: true });
        console.log(`Cleared directory ${outputDir}`);
        await ensureOutputDir(outputDir);
    } catch (error) {
        console.error(`Failed to clear directory ${outputDir}: ${error.message}`);
    }

    // Log contents of /tmp/output before starting
    try {
        const tmpFiles = await fs.readdir(path.join('/tmp', 'output')).catch(() => []);
        console.log(`Contents of /tmp/output: ${tmpFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list /tmp/output contents: ${error.message}`);
    }

    // Extract storeId, addressId, and headers by intercepting store_fees request
    await page.setRequestInterception(true);
    let captured = null;
    const storeFeesRe = /\/v1\/stores\/(\d+)\/addresses\/(\d+)\/node\/store_fees\b/i;
    page.on('request', (request) => {
        const url = request.url();
        if (storeFeesRe.test(url)) {
            const match = url.match(storeFeesRe);
            const storeId = match?.[1] || null;
            const addressId = match?.[2] || null;
            const headers = request.headers();
            const lang = headers['glovo-language-code'] || headers['Glovo-Language-Code'] || null;
            const city = headers['glovo-location-city-code'] || headers['Glovo-Location-City-Code'] || null;
            const country = headers['glovo-location-country-code'] || headers['Glovo-Location-Country-Code'] || null;
            if (storeId && addressId && lang && city && country) {
                captured = {
                    storeId,
                    addressId,
                    lang: lang.toLowerCase(),
                    city: city.toUpperCase(),
                    country: country.toUpperCase()
                };
                console.log(`Captured from store_fees: ${JSON.stringify(captured)}`);
            } else {
                console.warn(`store_fees seen but missing headers/ids: ${JSON.stringify({ storeId, addressId, lang, city, country })}`);
            }
        }
        request.continue();
    });

    // Navigate to the restaurant page to trigger store_fees request
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36');
    console.log(`Navigating to ${restaurantUrl}`);
    try {
        await page.goto(restaurantUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (error) {
        console.error(`Failed to navigate to ${restaurantUrl}: ${error.message}`);
        throw error;
    }

    // Wait up to 10s for store_fees request
    const waitUntil = Date.now() + 10000;
    while (!captured && Date.now() < waitUntil) {
        await delay(150);
    }
    page.off('request'); // Clean up request interception

    if (!captured) {
        console.error('No store_fees request captured. Ensure page loaded correctly.');
        throw new Error('Failed to extract storeId or addressId from store_fees request');
    }

    const { storeId, addressId, lang, city, country } = captured;
    const base = 'https://api.glovoapp.com';
    const SLEEP_MS = 1000; // Base sleep for pagination
    const TIMEOUT_MS = 15000;
    const headers = {
        'accept': 'application/json',
        'glovo-api-version': '14',
        'glovo-app-platform': 'web',
        'glovo-app-type': 'customer',
        'glovo-app-version': '7',
        'glovo-language-code': lang,
        'glovo-location-country-code': country,
        'glovo-location-city-code': city
    };

    const dishes = [];
    const optionsList = [];
    const optionGroups = [];
    const usedIds = new Set();
    const usedOptionIds = new Map();
    const usedOptionGroupIds = new Map();
    let imageCount = 0;
    let optionCount = 0;
    let optionGroupCount = 0;
    let tagCount = 0;
    const menuUrl = restaurantUrl.endsWith('/') ? restaurantUrl : `${restaurantUrl}/`;
    const s3KeysToDelete = [];

    // Check for online shop format
    console.log('Checking for online shop format...');
    let isOnlineShop = false;
    let sections = [];
    try {
        const menuResponse = await axios.get(`${base}/v3/stores/${storeId}/addresses/${addressId}/node/store_menu`, {
            headers,
            timeout: TIMEOUT_MS
        }).catch(e => ({ data: { error: e.message } }));
        if (menuResponse.data.error) {
            console.warn(`store_menu failed: ${menuResponse.data.error}`);
        } else if (menuResponse.status === 200) {
            const menu = menuResponse.data?.data?.elements || [];
            const collectSections = (root) => {
                const out = [], seen = new Set();
                function walk(node, path) {
                    const N = node?.data ? node.data : node;
                    if (!N || typeof N !== 'object') return;
                    const name = N.name || N.title || null;
                    const next = name ? [...path, name] : path;
                    const id = N?.tracking?.sectionId || N?.tracking?.collectionId || null;
                    if (id && !seen.has(id)) {
                        seen.add(id);
                        out.push({ collectionSectionId: id, names: next });
                    }
                    const kids = Array.isArray(N.elements) ? N.elements : [];
                    for (const k of kids) walk(k, next);
                }
                for (const r of root) walk(r, []);
                return out;
            };
            sections = collectSections(menu);
            console.log(`Found ${sections.length} sections`);

            // Add 10-second delay after finding sections
            if (sections.length > 0) {
                console.log('Waiting 10 seconds before extracting items...');
                await delay(10000);
            }

            // Check for PRODUCT_TILE in first section
            if (sections.length > 0) {
                const firstSection = sections[0];
                const qs = new URLSearchParams({ component: 'section', id: firstSection.collectionSectionId });
                const maxRetries = 3;
                let partialResponse = null;
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        partialResponse = await axios.get(`${base}/v4/stores/${storeId}/addresses/${addressId}/content/partial?${qs}`, {
                            headers,
                            timeout: TIMEOUT_MS
                        });
                        break;
                    } catch (e) {
                        if (e.response?.status === 429) {
                            console.warn(`partial[first] ${firstSection.collectionSectionId} attempt ${attempt}: Rate limit hit (429), retrying after ${1000 * Math.pow(2, attempt - 1)}ms`);
                            if (attempt === maxRetries) {
                                console.error(`Failed to fetch partial[first] ${firstSection.collectionSectionId} after ${maxRetries} attempts: ${e.message}`);
                                break;
                            }
                            await delay(1000 * Math.pow(2, attempt - 1));
                        } else {
                            console.warn(`partial[first] ${firstSection.collectionSectionId}: ${e.message}`);
                            break;
                        }
                    }
                }
                if (partialResponse?.status === 200) {
                    const extractTilesRecursive = (obj, names) => {
                        const out = [];
                        if (!obj || typeof obj !== 'object') return out;
                        if (Array.isArray(obj)) {
                            for (const item of obj) {
                                out.push(...extractTilesRecursive(item, names));
                            }
                        } else {
                            if (obj.type === 'PRODUCT_TILE' && obj.data) {
                                const p = obj.data;
                                const price = p?.priceInfo?.displayText ?? p?.priceInfo?.amount ?? p?.price ?? null;
                                const image = p?.imageUrl || p?.imageURL || p?.imageId ||
                                    (Array.isArray(p.images) ? (p.images[0]?.imageUrl || p.images[0]?.imageURL || p.images[0]?.imageId) : null);
                                out.push({
                                    category: names[0] ?? null,
                                    subcategory: names[1] ?? null,
                                    subsubcategory: names[2] ?? null,
                                    itemName: p?.name ?? null,
                                    itemDescription: p?.description ?? null,
                                    itemPrice: price,
                                    currency: p?.priceInfo?.currencyCode ?? null,
                                    itemImage: image,
                                    itemCustomizations: p?.attributeGroups?.map(g => ({
                                        name: g?.name || null,
                                        options: (g?.attributes || []).map(a => ({
                                            name: a?.name || null,
                                            price: a?.price ? String(a.price) : null,
                                        }))
                                    })) ?? [],
                                    productId: (p?.id ?? p?.storeProductId ?? null) && String(p.id ?? p.storeProductId),
                                    source: 'shop'
                                });
                            }
                            for (const key in obj) {
                                out.push(...extractTilesRecursive(obj[key], names));
                            }
                        }
                        return out;
                    };
                    const body = partialResponse.data?.data?.body || [];
                    isOnlineShop = extractTilesRecursive(body, firstSection.names).length > 0;
                }
            }
        }
    } catch (e) {
        console.warn(`store_menu failed; proceeding to restaurant fallback: ${e.message}`);
    }
    console.log(`Detected format: ${isOnlineShop ? 'Online Shop' : 'Restaurant'}`);

    if (isOnlineShop) {
        // Online Shop Format
        console.log('Scraping Glovo Online Shop format...');
        const fetchSectionAll = async (sectionId, names) => {
            const items = [];
            let qs = new URLSearchParams({ component: 'section', id: sectionId });
            const maxRetries = 3;
            let json = null;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    json = await axios.get(`${base}/v4/stores/${storeId}/addresses/${addressId}/content/partial?${qs}`, {
                        headers,
                        timeout: TIMEOUT_MS
                    });
                    break;
                } catch (e) {
                    if (e.response?.status === 429) {
                        console.warn(`partial[first] ${sectionId} attempt ${attempt}: Rate limit hit (429), retrying after ${1000 * Math.pow(2, attempt - 1)}ms`);
                        if (attempt === maxRetries) {
                            console.error(`Failed to fetch partial[first] ${sectionId} after ${maxRetries} attempts: ${e.message}`);
                            return items;
                        }
                        await delay(1000 * Math.pow(2, attempt - 1));
                    } else {
                        console.warn(`partial[first] ${sectionId}: ${e.message}`);
                        return items;
                    }
                }
            }
            if (json.data.error) {
                console.warn(`partial[first] ${sectionId}: ${json.data.error}`);
                return items;
            }
            const extractTilesRecursive = (obj, names) => {
                const out = [];
                if (!obj || typeof obj !== 'object') return out;
                if (Array.isArray(obj)) {
                    for (const item of obj) {
                        out.push(...extractTilesRecursive(item, names));
                    }
                } else {
                    if (obj.type === 'PRODUCT_TILE' && obj.data) {
                        const p = obj.data;
                        const price = p?.priceInfo?.displayText ?? p?.priceInfo?.amount ?? p?.price ?? null;
                        const image = p?.imageUrl || p?.imageURL || p?.imageId ||
                            (Array.isArray(p.images) ? (p.images[0]?.imageUrl || p.images[0]?.imageURL || p.images[0]?.imageId) : null);
                        out.push({
                            category: names[0] ?? null,
                            subcategory: names[1] ?? null,
                            subsubcategory: names[2] ?? null,
                            itemName: p?.name ?? null,
                            itemDescription: p?.description ?? null,
                            itemPrice: price,
                            currency: p?.priceInfo?.currencyCode ?? null,
                            itemImage: image,
                            itemCustomizations: p?.attributeGroups?.map(g => ({
                                name: g?.name || null,
                                options: (g?.attributes || []).map(a => ({
                                    name: a?.name || null,
                                    price: a?.price ? String(a.price) : null,
                                }))
                            })) ?? [],
                            productId: (p?.id ?? p?.storeProductId ?? null) && String(p.id ?? p.storeProductId),
                            source: 'shop'
                        });
                    }
                    for (const key in obj) {
                        out.push(...extractTilesRecursive(obj[key], names));
                    }
                }
                return out;
            };
            items.push(...extractTilesRecursive(json.data, names));
            let { more, cursor, offset, limit } = {
                more: json.data?.data?.paging?.hasMore || json.data?.data?.paging?.hasNext || !!json.data?.data?.paging?.nextCursor,
                cursor: json.data?.data?.paging?.nextCursor || null,
                offset: typeof json.data?.data?.paging?.nextOffset === 'number' ? json.data?.data?.paging?.nextOffset : null,
                limit: json.data?.data?.paging?.limit || 100
            };
            let guard = 0;
            while (more && guard < 30) {
                guard++;
                const extra = {};
                if (cursor) extra.cursor = cursor;
                else if (offset != null) { extra.offset = offset; extra.limit = limit; }
                qs = new URLSearchParams({ component: 'section', id: sectionId, ...extra });
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        json = await axios.get(`${base}/v4/stores/${storeId}/addresses/${addressId}/content/partial?${qs}`, {
                            headers,
                            timeout: TIMEOUT_MS
                        });
                        break;
                    } catch (e) {
                        if (e.response?.status === 429) {
                            console.warn(`partial[${guard}] ${sectionId} attempt ${attempt}: Rate limit hit (429), retrying after ${1000 * Math.pow(2, attempt - 1)}ms`);
                            if (attempt === maxRetries) {
                                console.error(`Failed to fetch partial[${guard}] ${sectionId} after ${maxRetries} attempts: ${e.message}`);
                                return items;
                            }
                            await delay(1000 * Math.pow(2, attempt - 1));
                        } else {
                            console.warn(`partial[${guard}] ${sectionId}: ${e.message}`);
                            return items;
                        }
                    }
                }
                if (json.data.error) {
                    console.warn(`partial[${guard}] ${sectionId}: ${json.data.error}`);
                    break;
                }
                items.push(...extractTilesRecursive(json.data, names));
                ({ more, cursor, offset, limit } = {
                    more: json.data?.data?.paging?.hasMore || json.data?.data?.paging?.hasNext || !!json.data?.data?.paging?.nextCursor,
                    cursor: json.data?.data?.paging?.nextCursor || null,
                    offset: typeof json.data?.data?.paging?.nextOffset === 'number' ? json.data?.data?.paging?.nextOffset : null,
                    limit: json.data?.data?.paging?.limit || 100
                });
                await delay(SLEEP_MS + Math.random() * 500);
            }
            return items;
        };

        // Fetch sections concurrently (up to 2 at a time to avoid rate limits)
        const batchSize = 2;
        const allItems = [];
        for (let i = 0; i < sections.length; i += batchSize) {
            const batch = sections.slice(i, i + batchSize);
            const batchPromises = batch.map(s => {
                if (!s.collectionSectionId) return Promise.resolve([]);
                console.log(`Fetching section ${s.collectionSectionId}...`);
                return fetchSectionAll(s.collectionSectionId, s.names);
            });
            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(items => allItems.push(...items));
            await delay(SLEEP_MS + Math.random() * 500);
        }

        console.log(`Fetched ${allItems.length} items from Glovo Online Shop`);

        for (const item of allItems) {
            const name = normalizeText(item.itemName || '');
            if (!name) {
                console.warn(`Skipping item with empty name: ${JSON.stringify(item)}`);
                continue;
            }

            const dishId = generateDishId(name, usedIds);
            const categoryName = normalizeText(item.category || 'Unknown Category');
            const tags = assignTags(name);
            tagCount += tags.length;

            // Image handling
            let imagePath = '';
            let imageAttachment = [];
            const imageUrl = item.itemImage || '';
            if (imageUrl && imageUrl.startsWith('http')) {
                console.log(`Image URL for ${name}: ${imageUrl}`);
                const safeName = sanitizeFilename(name, true);
                const uniqueId = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
                const maxBaseLength = 50 - (uniqueId.length + 5);
                const finalBaseName = safeName.substring(0, maxBaseLength);
                const localFilePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
                try {
                    const downloadResult = await downloadImage(restaurantUrl, imageUrl, localFilePath, restaurantName, name);
                    if (downloadResult && fsSync.existsSync(localFilePath)) {
                        s3KeysToDelete.push(downloadResult.s3Key);
                        const resizeResult = await resizeImage(downloadResult.s3Key, localFilePath, restaurantName, name);
                        if (resizeResult) {
                            imagePath = resizeResult.url;
                            imageAttachment = [{ url: resizeResult.url, filename: resizeResult.filename }];
                            imageCount++;
                            console.log(`Image processed for ${name}: ${resizeResult.url}`);
                        } else {
                            console.warn(`Failed to resize image for ${name} from s3://synapseimage/${downloadResult.s3Key}`);
                        }
                    } else {
                        console.warn(`Image download failed for ${name}: ${localFilePath}`);
                    }
                } catch (err) {
                    console.error(`Failed to process image for ${name}: ${err.message}`);
                    await fs.unlink(localFilePath).catch(() => {});
                }
            } else {
                console.log(`No valid image URL for ${name}`);
            }

            const dishOptionGroupIds = [];
            dishes.push({
                id: dishId,
                category: categoryName,
                dishName: name,
                price: cleanPrice(item.itemPrice),
                description: normalizeText(item.itemDescription || ''),
                image: imagePath,
                optionGroups: '',
                tags: tags,
                imageAttachment
            });

            // Process customizations
            for (const customization of item.itemCustomizations || []) {
                const optionGroupName = normalizeText(customization.name || '');
                if (!optionGroupName) {
                    console.warn(`Skipping customization with empty name for ${name}`);
                    continue;
                }
                const isCounterType = optionGroupName.toLowerCase().includes('sos') || optionGroupName.toLowerCase().includes('dodatki');
                const optionGroupType = isCounterType ? 'counter' : 'multi_select';
                let optionGroupId;
                if (!usedOptionGroupIds.has(optionGroupName)) {
                    usedOptionGroupIds.set(optionGroupName, `optionGroup${++optionGroupCount}`);
                    optionGroupId = usedOptionGroupIds.get(optionGroupName);
                    const optionIds = [];
                    for (const option of customization.options || []) {
                        const price = cleanPrice(option.price || '0.00');
                        const optionName = normalizeText(option.name || '');
                        if (!optionName) {
                            console.warn(`Skipping option with empty name for ${optionGroupName}`);
                            continue;
                        }
                        const optionKey = `${optionName}:${price}`;
                        const isFree = parseFloat(price) === 0;
                        let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                        if (usedOptionIds.has(optionKey)) {
                            optionId = usedOptionIds.get(optionKey);
                            if (!optionIds.includes(optionId)) {
                                optionIds.push(optionId);
                            }
                            continue;
                        }
                        usedOptionIds.set(optionKey, optionId);
                        optionsList.push({
                            optionId: optionId,
                            price: price,
                            name: optionName,
                            translatedItemName: '',
                            optionGroups: optionGroupId,
                            extrasId: '',
                            isFree: isFree
                        });
                        optionIds.push(optionId);
                        optionCount++;
                    }
                    if (optionIds.length > 0) {
                        optionGroups.push({
                            optionGroupId: optionGroupId,
                            name: optionGroupName,
                            nameEnUS: '',
                            optionGroupType: optionGroupType,
                            optionGroupMin: 0,
                            optionGroupMax: optionIds.length,
                            optionGroupEachMax: optionGroupType === 'counter' ? 10 : 1,
                            dishUrl: `${menuUrl}${item.productId}`,
                            options: [...new Set(optionIds)],
                            dishes: [dishId]
                        });
                        dishOptionGroupIds.push(optionGroupId);
                    }
                } else {
                    optionGroupId = usedOptionGroupIds.get(optionGroupName);
                    const existingOptionGroup = optionGroups.find(og => og.optionGroupId === optionGroupId);
                    if (existingOptionGroup && !existingOptionGroup.dishes.includes(dishId)) {
                        existingOptionGroup.dishes.push(dishId);
                        dishOptionGroupIds.push(optionGroupId);
                        const optionIds = [];
                        for (const option of customization.options || []) {
                            const price = cleanPrice(option.price || '0.00');
                            const optionName = normalizeText(option.name || '');
                            if (!optionName) {
                                console.warn(`Skipping option with empty name for ${optionGroupName}`);
                                continue;
                            }
                            const optionKey = `${optionName}:${price}`;
                            const isFree = parseFloat(price) === 0;
                            let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                            if (usedOptionIds.has(optionKey)) {
                                optionId = usedOptionIds.get(optionKey);
                                if (!optionIds.includes(optionId) && !existingOptionGroup.options.includes(optionId)) {
                                    optionIds.push(optionId);
                                    existingOptionGroup.options.push(optionId);
                                }
                                continue;
                            }
                            usedOptionIds.set(optionKey, optionId);
                            optionsList.push({
                                optionId: optionId,
                                price: price,
                                name: optionName,
                                translatedItemName: '',
                                optionGroups: optionGroupId,
                                extrasId: '',
                                isFree: isFree
                            });
                            optionIds.push(optionId);
                            existingOptionGroup.options.push(optionId);
                            optionCount++;
                        }
                        existingOptionGroup.options = [...new Set(existingOptionGroup.options)];
                    }
                }
            }
            dishes.find(d => d.id === dishId).optionGroups = dishOptionGroupIds.join(', ');
        }
    } else {
        // Restaurant Format
        console.log('Scraping Glovo Restaurant format...');
        const content = await axios.get(`${base}/v3/stores/${storeId}/addresses/${addressId}/content`, {
            headers,
            timeout: TIMEOUT_MS
        }).catch(e => ({ data: { error: e.message } }));
        if (content.data.error) {
            console.error(`Restaurant content failed: ${content.data.error}`);
            throw new Error('Failed to retrieve Glovo restaurant API data');
        }
        const body = content.data?.data?.body || [];
        const allItems = [];
        for (const sec of body) {
            if (sec?.type !== 'LIST') continue;
            const groupName = sec?.data?.title || sec?.data?.slug || null;
            for (const el of (sec?.data?.elements || [])) {
                if (el?.type !== 'PRODUCT_ROW') continue;
                const p = el.data || {};
                const image = p?.imageUrl || p?.imageId ||
                    (Array.isArray(p.images) ? (p.images[0]?.imageUrl || p.images[0]?.imageId) : null);
                allItems.push({
                    category: groupName,
                    subcategory: null,
                    subsubcategory: null,
                    itemName: p?.name ?? null,
                    itemDescription: p?.description ?? null,
                    itemPrice: p?.priceInfo?.amount ?? p?.price ?? null,
                    currency: p?.priceInfo?.currencyCode ?? null,
                    itemImage: image,
                    itemCustomizations: p?.attributeGroups?.map(g => ({
                        name: g?.name || null,
                        options: (g?.attributes || []).map(a => ({
                            name: a?.name || null,
                            price: a?.price ? String(a.price) : null,
                        }))
                    })) ?? [],
                    productId: (p?.id ?? p?.storeProductId ?? null) && String(p.id ?? p.storeProductId),
                    source: 'restaurant'
                });
            }
        }
        console.log(`Fetched ${allItems.length} items from Glovo Restaurant`);
        for (const item of allItems) {
            const name = normalizeText(item.itemName || '');
            if (!name) {
                console.warn(`Skipping item with empty name: ${JSON.stringify(item)}`);
                continue;
            }
            const dishId = generateDishId(name, usedIds);
            const categoryName = normalizeText(item.category || 'Unknown Category');
            const tags = assignTags(name);
            tagCount += tags.length;
            // Image handling
            let imagePath = '';
            let imageAttachment = [];
            const imageUrl = item.itemImage || '';
            if (imageUrl && imageUrl.startsWith('http')) {
                console.log(`Image URL for ${name}: ${imageUrl}`);
                const safeName = sanitizeFilename(name, true);
                const uniqueId = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
                const maxBaseLength = 50 - (uniqueId.length + 5);
                const finalBaseName = safeName.substring(0, maxBaseLength);
                const localFilePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
                try {
                    const downloadResult = await downloadImage(restaurantUrl, imageUrl, localFilePath, restaurantName, name);
                    if (downloadResult && fsSync.existsSync(localFilePath)) {
                        s3KeysToDelete.push(downloadResult.s3Key);
                        const resizeResult = await resizeImage(downloadResult.s3Key, localFilePath, restaurantName, name);
                        if (resizeResult) {
                            imagePath = resizeResult.url;
                            imageAttachment = [{ url: resizeResult.url, filename: resizeResult.filename }];
                            imageCount++;
                            console.log(`Image processed for ${name}: ${resizeResult.url}`);
                        } else {
                            console.warn(`Failed to resize image for ${name} from s3://synapseimage/${downloadResult.s3Key}`);
                        }
                    } else {
                        console.warn(`Image download failed for ${name}: ${localFilePath}`);
                    }
                } catch (err) {
                    console.error(`Failed to process image for ${name}: ${err.message}`);
                    await fs.unlink(localFilePath).catch(() => {});
                }
            } else {
                console.log(`No valid image URL for ${name}`);
            }
            const dishOptionGroupIds = [];
            dishes.push({
                id: dishId,
                category: categoryName,
                dishName: name,
                price: cleanPrice(item.itemPrice),
                description: normalizeText(item.itemDescription || ''),
                image: imagePath,
                optionGroups: '',
                tags: tags,
                imageAttachment
            });
            // Process customizations
            for (const customization of item.itemCustomizations || []) {
                const optionGroupName = normalizeText(customization.name || '');
                if (!optionGroupName) {
                    console.warn(`Skipping customization with empty name for ${name}`);
                    continue;
                }
                const isCounterType = optionGroupName.toLowerCase().includes('sos') || optionGroupName.toLowerCase().includes('dodatki');
                const optionGroupType = isCounterType ? 'counter' : 'multi_select';
                let optionGroupId;
                if (!usedOptionGroupIds.has(optionGroupName)) {
                    usedOptionGroupIds.set(optionGroupName, `optionGroup${++optionGroupCount}`);
                    optionGroupId = usedOptionGroupIds.get(optionGroupName);
                    const optionIds = [];
                    for (const option of customization.options || []) {
                        const price = cleanPrice(option.price || '0.00');
                        const optionName = normalizeText(option.name || '');
                        if (!optionName) {
                            console.warn(`Skipping option with empty name for ${optionGroupName}`);
                            continue;
                        }
                        const optionKey = `${optionName}:${price}`;
                        const isFree = parseFloat(price) === 0;
                        let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                        if (usedOptionIds.has(optionKey)) {
                            optionId = usedOptionIds.get(optionKey);
                            if (!optionIds.includes(optionId)) {
                                optionIds.push(optionId);
                            }
                            continue;
                        }
                        usedOptionIds.set(optionKey, optionId);
                        optionsList.push({
                            optionId: optionId,
                            price: price,
                            name: optionName,
                            translatedItemName: '',
                            optionGroups: optionGroupId,
                            extrasId: '',
                            isFree: isFree
                        });
                        optionIds.push(optionId);
                        optionCount++;
                    }
                    if (optionIds.length > 0) {
                        optionGroups.push({
                            optionGroupId: optionGroupId,
                            name: optionGroupName,
                            nameEnUS: '',
                            optionGroupType: optionGroupType,
                            optionGroupMin: 0,
                            optionGroupMax: optionIds.length,
                            optionGroupEachMax: optionGroupType === 'counter' ? 10 : 1,
                            dishUrl: `${menuUrl}${item.productId}`,
                            options: [...new Set(optionIds)],
                            dishes: [dishId]
                        });
                        dishOptionGroupIds.push(optionGroupId);
                    }
                } else {
                    optionGroupId = usedOptionGroupIds.get(optionGroupName);
                    const existingOptionGroup = optionGroups.find(og => og.optionGroupId === optionGroupId);
                    if (existingOptionGroup && !existingOptionGroup.dishes.includes(dishId)) {
                        existingOptionGroup.dishes.push(dishId);
                        dishOptionGroupIds.push(optionGroupId);
                        const optionIds = [];
                        for (const option of customization.options || []) {
                            const price = cleanPrice(option.price || '0.00');
                            const optionName = normalizeText(option.name || '');
                            if (!optionName) {
                                console.warn(`Skipping option with empty name for ${optionGroupName}`);
                                continue;
                            }
                            const optionKey = `${optionName}:${price}`;
                            const isFree = parseFloat(price) === 0;
                            let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                            if (usedOptionIds.has(optionKey)) {
                                optionId = usedOptionIds.get(optionKey);
                                if (!optionIds.includes(optionId) && !existingOptionGroup.options.includes(optionId)) {
                                    optionIds.push(optionId);
                                    existingOptionGroup.options.push(optionId);
                                }
                                continue;
                            }
                            usedOptionIds.set(optionKey, optionId);
                            optionsList.push({
                                optionId: optionId,
                                price: price,
                                name: optionName,
                                translatedItemName: '',
                                optionGroups: optionGroupId,
                                extrasId: '',
                                isFree: isFree
                            });
                            optionIds.push(optionId);
                            existingOptionGroup.options.push(optionId);
                            optionCount++;
                        }
                        existingOptionGroup.options = [...new Set(existingOptionGroup.options)];
                    }
                }
            }
            dishes.find(d => d.id === dishId).optionGroups = dishOptionGroupIds.join(', ');
        }
    }

    // Clean up toResize/ images
    if (s3KeysToDelete.length > 0) {
        await cleanS3ToResize(restaurantName, s3KeysToDelete);
    }

    // Log contents of /tmp/output/<restaurantName>/pics after processing
    try {
        const imageFiles = await fs.readdir(outputDir).catch(() => []);
        console.log(`Images in ${outputDir} after processing: ${imageFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list images in ${outputDir}: ${error.message}`);
    }

    // Add a delay to ensure all S3 operations are complete
    console.log('Waiting 2 seconds to ensure S3 operations are complete...');
    await delay(2000);

    // Log contents again before CSV writing
    try {
        const imageFiles = await fs.readdir(outputDir).catch(() => []);
        console.log(`Images in ${outputDir} before CSV writing: ${imageFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list images in ${outputDir} before CSV writing: ${error.message}`);
    }

    console.log(`Extracted ${dishes.length} dishes, ${new Set(dishes.map(d => d.category)).size} categories, ${imageCount} images, ${optionCount} options, ${optionGroupCount} option groups, ${tagCount} tags`);
    if (dishes.length > 0) console.log('Sample dish:', dishes[0]);
    if (optionGroups.length > 0) console.log('Sample option group:', optionGroups[0]);
    if (optionsList.length > 0) console.log('Sample option:', optionsList[0]);

    // Save raw JSON
    const rawData = { dishes, options: optionsList, optionGroups };
    await fs.writeFile(path.join('/tmp', 'output', `${restaurantName}_raw.json`), JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`Raw JSON saved: /tmp/output/${restaurantName}_raw.json`);

    return {
        dishes,
        options: optionsList,
        optionGroups,
        startTime: Date.now(),
        counters: {
            dishes: dishes.length,
            categories: new Set(dishes.map(d => d.category)).size,
            images: imageCount,
            options: optionCount,
            optionGroups: optionGroupCount,
            tags: tagCount
        }
    };
}
async function scrapeFoodora(page, restaurantUrl, restaurantName) {
    console.log('Scraping Foodora via API...');
    const outputDir = path.join('/tmp', 'output', restaurantName, 'pics');
    await ensureOutputDir(outputDir);
    // Clear the output directory
    console.log(`Clearing directory ${outputDir}`);
    try {
        await fs.rm(outputDir, { recursive: true, force: true });
        console.log(`Cleared directory ${outputDir}`);
        await ensureOutputDir(outputDir);
    } catch (error) {
        console.error(`Failed to clear directory ${outputDir}: ${error.message}`);
    }
    // Log contents of /tmp/output
    try {
        const tmpFiles = await fs.readdir(path.join('/tmp', 'output')).catch(() => []);
        console.log(`Contents of /tmp/output: ${tmpFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list /tmp/output contents: ${error.message}`);
    }
    // Extract country code from URL
    let countryCode = 'se'; // Default to Sweden
    const urlMatch = restaurantUrl.match(/foodora\.([a-z]{2})/i);
    if (urlMatch && urlMatch[1]) {
        countryCode = urlMatch[1].toLowerCase();
        console.log(`Extracted country code from URL: ${countryCode}`);
    } else {
        console.warn(`Could not extract country code from URL: ${restaurantUrl}, defaulting to 'se'`);
    }
    // Map country code to API base URL
    const apiBaseMap = {
        'se': 'se.fd-api.com', // Sweden, Finland
        'no': 'no.fd-api.com', // Norway
        'hu': 'hu.fd-api.com', // Hungary
        'at': 'at.fd-api.com', // Austria
        'cz': 'cz.fd-api.com', // Czech Republic
    };
    const apiBase = apiBaseMap[countryCode] || 'op.fd-api.com'; // Fallback to op.fd-api.com
    console.log(`Using API base: ${apiBase}`);
    // Extract vendor_id from URL or network requests
    let vendorId = null;
    const urlParts = restaurantUrl.match(/\/restaurant\/([^/]+)\//);
    if (urlParts && urlParts[1]) {
        vendorId = urlParts[1];
        console.log(`Extracted vendor_id from URL: ${vendorId}`);
    } else {
        // Fallback to network request interception
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url();
            if (url.includes('fd-api.com/api/v5/vendors/')) {
                const match = url.match(/\/vendors\/([^?]+)/);
                if (match && match[1]) {
                    vendorId = match[1];
                    console.log(`Extracted vendor_id from network request: ${vendorId}`);
                }
            }
            request.continue();
        });
        // Navigate to the restaurant page to trigger the vendor request
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/139.0.0.0 Safari/537.36');
        console.log(`Navigating to ${restaurantUrl}`);
        await page.goto(restaurantUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        // Wait for vendor_id to be captured
        let attempts = 0;
        const maxAttempts = 10;
        while (!vendorId && attempts < maxAttempts) {
            await delay(1000);
            attempts++;
        }
        page.off('request'); // Clean up request interception
        if (!vendorId) {
            throw new Error('Failed to extract vendor_id from URL or network requests');
        }
    }
    // Construct API URL with query parameters
    const queryParams = countryCode === 'cz'
        ? 'include=menus,bundles,multiple_discounts,payment_types&language_id=3&opening_type=delivery&basket_currency=CZK'
        : 'include=menus';
    const apiUrl = `https://${apiBase}/api/v5/vendors/${vendorId}?${queryParams}`;
    console.log(`Fetching Foodora API: ${apiUrl}`);
    const headers = {
        'accept': 'application/json, text/plain, */*',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'api-version': '7',
        'dps-session-id': 'eyJzZXNzaW9uX2lkIjoiMjI2MjY1MDcwMGEwZTI4MzYwYmIwZjc0Nzg3MzRhNGQiLCJwZXJ1c2lkIjoiMTc1NDQ2NTExMTA4Ny4wMTcyNDQ3ODQzMDQ0MDgyNTEuZnZqcnNlcG51NCIsInRpbWVzdGFtcCI6MTc1NTcyMTAwN30=',
        'origin': `https://www.foodora.${countryCode}`,
        'perseus-client-id': '1754465111087.017244784304408251.fvjrsepnu4',
        'perseus-session-id': '1755720917177.891197851651743012.vcagao9vcn',
        'priority': 'u=1, i',
        'referer': `https://www.foodora.${countryCode}/`,
        'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        'x-fp-api-key': 'volo',
        'x-pd-language-id': countryCode === 'cz' ? '3' : '4'
    };
    const maxRetries = 3;
    let apiResponse = null;
    const s3KeysToDelete = [];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(apiUrl, { headers });
            if (response.status === 200) {
                apiResponse = response.data;
                console.log('API response received:', JSON.stringify(apiResponse, null, 2));
                break;
            } else if (response.status === 429) {
                console.warn(`Rate limit hit on attempt ${attempt}, retrying after delay`);
                await delay(2000 * Math.pow(2, attempt - 1));
            } else {
                throw new Error(`API request failed with status ${response.status}`);
            }
        } catch (error) {
            console.error(`API attempt ${attempt} failed: ${error.message}`);
            if (attempt === maxRetries) {
                throw new Error(`Failed to fetch Foodora API after ${maxRetries} attempts: ${error.message}`);
            }
            await delay(2000 * Math.pow(2, attempt - 1));
        }
    }
    if (!apiResponse) {
        throw new Error('Failed to retrieve Foodora API data');
    }
    // Log response structure for debugging
    console.log('Response keys:', Object.keys(apiResponse || {}));
    if (apiResponse.data) {
        console.log('Data keys:', Object.keys(apiResponse.data));
        if (apiResponse.data.menus) {
            console.log('Menus length:', apiResponse.data.menus.length);
            if (apiResponse.data.menus[0]?.menu_categories) {
                console.log('Menu_categories length:', apiResponse.data.menus[0].menu_categories.length);
            }
        }
    }
    // Parse API response
    const menuUrl = restaurantUrl.endsWith('/') ? restaurantUrl : `${restaurantUrl}/`;
    const sections = apiResponse.data?.menus?.[0]?.menu_categories || apiResponse.data?.categories || [];
    const items = sections.flatMap(section => section.products || []);
    const optionGroupsData = {};
    const optionGroupsArray = apiResponse.data?.menus?.[0]?.option_groups || [];
    optionGroupsArray.forEach(group => {
        optionGroupsData[group.id] = group;
    });
    if (sections.length === 0 || items.length === 0) {
        console.warn('No menu data found in response. Store may be closed or have no items.');
    }
    const categoryMap = new Map();
    const categorySet = new Set();
    const dishes = [];
    const optionsList = [];
    const optionGroups = [];
    const usedIds = new Set();
    const usedOptionIds = new Map();
    const usedOptionGroupIds = new Map();
    let imageCount = 0;
    let optionCount = 0;
    let optionGroupCount = 0;
    // Extract categories
    for (const section of sections) {
        const categoryName = normalizeText(section.name || section.title || 'Unknown Category');
        categorySet.add(categoryName);
        const itemIds = (section.products || []).map(item => String(item.id) || item.code || '');
        for (const itemId of itemIds) {
            categoryMap.set(itemId, categoryName);
        }
    }
    // Process items
    for (const item of items) {
        const itemId = String(item.id) || item.code || '';
        if (!itemId) continue; // Skip items without ID
        const categoryName = categoryMap.get(itemId) || 'Unknown Category';
        const dishId = generateDishId(item.name || item.title, usedIds);
        let imagePath = '';
        let imageAttachment = [];
        const imageUrl = item.file_path || item.image || item.image_url || item.images?.[0]?.url || '';
        if (imageUrl && imageUrl.startsWith('http')) {
            console.log(`Image URL for ${item.name || item.title}: ${imageUrl}`);
            const safeName = sanitizeFilename(item.name || item.title, true);
            const uniqueId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            const maxBaseLength = 50 - (uniqueId.length + 5);
            const finalBaseName = safeName.substring(0, maxBaseLength);
            const filePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
            try {
                const downloadResult = await downloadImage(restaurantUrl, imageUrl, filePath, restaurantName, item.name || item.title);
                if (downloadResult && fsSync.existsSync(filePath)) {
                    s3KeysToDelete.push(downloadResult.s3Key);
                    const resizeResult = await resizeImage(downloadResult.s3Key, filePath, restaurantName, item.name || item.title);
                    if (resizeResult) {
                        imagePath = resizeResult.url;
                        imageAttachment = [{ url: resizeResult.url, filename: resizeResult.filename }];
                        imageCount++;
                        console.log(`Image processed for ${item.name || item.title}: ${resizeResult.url}`);
                    } else {
                        console.warn(`Failed to resize image for ${item.name || item.title} from s3://synapseimage/${downloadResult.s3Key}`);
                    }
                } else {
                    console.warn(`Image download failed for ${item.name || item.title}: ${filePath}`);
                }
            } catch (error) {
                console.error(`Failed to process image for ${item.name || item.title}: ${error.message}`);
                await fs.unlink(filePath).catch(() => {});
            }
        } else {
            console.log(`No valid image URL for ${item.name || item.title}`);
        }
        const price = cleanPrice((item.product_variations?.[0]?.price / 100 || item.price || 0).toFixed(2) || '0.00');
        const dishOptionGroupIds = [];
        dishes.push({
            id: dishId,
            category: categoryName,
            dishName: normalizeText(item.name || item.title || ''),
            price: price,
            description: normalizeText(item.description || ''),
            image: imagePath,
            optionGroups: '',
            imageAttachment
        });
        // Process customizations (options)
        const toppingIds = item.product_variations?.[0]?.topping_ids || [];
        const customizations = toppingIds.map(id => optionGroupsData[id]).filter(Boolean);
        for (const customization of customizations) {
            const optionGroupName = normalizeText(customization.name || customization.title || '');
            if (!optionGroupName) continue;
            const isCounterType = optionGroupName.toLowerCase().includes('sos') || optionGroupName.toLowerCase().includes('dodatki');
            const optionGroupType = isCounterType ? 'counter' : customization.type === 'choice-group' ? 'multi_select' : 'single_select';
            let optionGroupId;
            if (!usedOptionGroupIds.has(optionGroupName)) {
                usedOptionGroupIds.set(optionGroupName, `optionGroup${++optionGroupCount}`);
                optionGroupId = usedOptionGroupIds.get(optionGroupName);
                const optionGroupMin = customization.min || customization.min_selections || 0;
                const optionGroupMax = customization.max || customization.max_selections || 0;
                const optionGroupEachMax = optionGroupType === 'counter' ? 10 : 1;
                const optionIds = [];
                const options = customization.options || customization.items || customization.extras || [];
                for (const option of options) {
                    const price = cleanPrice((option.price?.amount / 100 || option.price || 0).toFixed(2) || '0.00');
                    const optionName = normalizeText(option.name || option.title || '');
                    if (!optionName) continue;
                    const optionKey = `${optionName}:${price}`;
                    const isFree = parseFloat(price) === 0;
                    let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                    if (usedOptionIds.has(optionKey)) {
                        optionId = usedOptionIds.get(optionKey);
                        if (!optionIds.includes(optionId)) {
                            optionIds.push(optionId);
                        }
                        continue;
                    }
                    usedOptionIds.set(optionKey, optionId);
                    optionsList.push({
                        optionId: optionId,
                        price: price,
                        name: optionName,
                        translatedItemName: '',
                        optionGroups: optionGroupId,
                        extrasId: option.id || option.code || option.remote_code || '',
                        isFree: isFree
                    });
                    optionIds.push(optionId);
                    optionCount++;
                }
                if (optionIds.length > 0) {
                    optionGroups.push({
                        optionGroupId: optionGroupId,
                        name: optionGroupName,
                        nameEnUS: '',
                        optionGroupType: optionGroupType,
                        optionGroupMin: optionGroupMin,
                        optionGroupMax: optionGroupMax,
                        optionGroupEachMax: optionGroupEachMax,
                        dishUrl: `${menuUrl}${itemId}`,
                        options: [...new Set(optionIds)],
                        dishes: [dishId]
                    });
                    dishOptionGroupIds.push(optionGroupId);
                }
            } else {
                optionGroupId = usedOptionGroupIds.get(optionGroupName);
                const existingOptionGroup = optionGroups.find(og => og.optionGroupId === optionGroupId);
                if (existingOptionGroup && !existingOptionGroup.dishes.includes(dishId)) {
                    existingOptionGroup.dishes.push(dishId);
                    dishOptionGroupIds.push(optionGroupId);
                    const optionIds = [];
                    const options = customization.options || customization.items || customization.extras || [];
                    for (const option of options) {
                        const price = cleanPrice((option.price?.amount / 100 || option.price || 0).toFixed(2) || '0.00');
                        const optionName = normalizeText(option.name || option.title || '');
                        if (!optionName) continue;
                        const optionKey = `${optionName}:${price}`;
                        const isFree = parseFloat(price) === 0;
                        let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
                        if (usedOptionIds.has(optionKey)) {
                            optionId = usedOptionIds.get(optionKey);
                            if (!optionIds.includes(optionId) && !existingOptionGroup.options.includes(optionId)) {
                                optionIds.push(optionId);
                                existingOptionGroup.options.push(optionId);
                            }
                            continue;
                        }
                        usedOptionIds.set(optionKey, optionId);
                        optionsList.push({
                            optionId: optionId,
                            price: price,
                            name: optionName,
                            translatedItemName: '',
                            optionGroups: optionGroupId,
                            extrasId: option.id || option.code || option.remote_code || '',
                            isFree: isFree
                        });
                        optionIds.push(optionId);
                        existingOptionGroup.options.push(optionId);
                        optionCount++;
                    }
                    existingOptionGroup.options = [...new Set(existingOptionGroup.options)];
                }
            }
        }
        dishes.find(d => d.id === dishId).optionGroups = dishOptionGroupIds.join(', ');
    }
    // Clean up toResize/ images
    if (s3KeysToDelete.length > 0) {
        await cleanS3ToResize(restaurantName, s3KeysToDelete);
    }
    // Log contents of /tmp/output/<restaurantName>/pics after processing
    try {
        const imageFiles = await fs.readdir(outputDir).catch(() => []);
        console.log(`Images in ${outputDir} after processing: ${imageFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list images in ${outputDir}: ${error.message}`);
    }
    // Add a delay to ensure all S3 operations are complete
    console.log('Waiting 2 seconds to ensure S3 operations are complete...');
    await delay(2000);
    // Log contents again before CSV writing
    try {
        const imageFiles = await fs.readdir(outputDir).catch(() => []);
        console.log(`Images in ${outputDir} before CSV writing: ${imageFiles.join(', ')}`);
    } catch (error) {
        console.error(`Failed to list images in ${outputDir} before CSV writing: ${error.message}`);
    }
    console.log(`Extracted ${dishes.length} dishes, ${categorySet.size} categories, ${imageCount} images, ${optionCount} options, ${optionGroupCount} option groups`);
    if (dishes.length > 0) console.log('Sample dish:', dishes[0]);
    if (optionGroups.length > 0) console.log('Sample option group:', optionGroups[0]);
    if (optionsList.length > 0) console.log('Sample option:', optionsList[0]);
    // Save raw JSON
    const rawData = { dishes, options: optionsList, optionGroups };
    await fs.writeFile(path.join('/tmp', 'output', `${restaurantName}_raw.json`), JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`Raw JSON saved: /tmp/output/${restaurantName}_raw.json`);
    return {
        dishes,
        options: optionsList,
        optionGroups,
        startTime: Date.now(),
        counters: {
            dishes: dishes.length,
            categories: categorySet.size,
            images: imageCount,
            options: optionCount,
            optionGroups: optionGroupCount,
            tags: 0
        }
    };
}

async function scrapePyszne(page, restaurantUrl, restaurantName) {
    console.log('Scraping Pyszne.pl via API...');
    
    // 1) Extract restaurant slug and country code from URL, override provided restaurantName
    let restaurantSlug = restaurantName;
    let countryCode = 'pl'; // Default to Poland
    const urlParts = restaurantUrl.match(/\/menu\/([^/]+)/);
    if (urlParts && urlParts[1]) {
      restaurantSlug = urlParts[1];
      console.log(`Extracted restaurant slug from URL: ${restaurantSlug}`);
    } else {
      console.warn(`Could not extract slug from URL: ${restaurantUrl}, using provided name: ${restaurantName}`);
    }
    // Check for country code in URL
    if (restaurantUrl.includes('pyszne.pt')) {
      countryCode = 'pt';
    } else if (restaurantUrl.includes('pyszne.pl')) {
      countryCode = 'pl';
    } else {
      console.warn(`Unknown country code in URL: ${restaurantUrl}, defaulting to pl`);
    }
    console.log(`Using country code: ${countryCode}`);
    restaurantName = restaurantSlug; // Use slug as restaurantName
    console.log(`Final restaurantName: ${restaurantName}`);
  
    // 2) Prepare output directory
    const outputDir = path.join('/tmp', 'output', restaurantName, 'pics');
    await ensureOutputDir(outputDir);
    console.log(`Clearing directory ${outputDir}`);
    try {
      await fs.rm(outputDir, { recursive: true, force: true });
      console.log(`Cleared directory ${outputDir}`);
      await ensureOutputDir(outputDir);
    } catch (error) {
      console.error(`Failed to clear directory ${outputDir}: ${error.message}`);
    }
    try {
      const tmpFiles = await fs.readdir(path.join('/tmp', 'output')).catch(() => []);
      console.log(`Contents of /tmp/output: ${tmpFiles.join(', ')}`);
    } catch (error) {
      console.error(`Failed to list /tmp/output contents: ${error.message}`);
    }
  
    // 3) Construct API URLs
    const itemsApiUrl = `https://globalmenucdn.eu-central-1.production.jet-external.com/${restaurantSlug}_${countryCode}_items.json`;
    const detailsApiUrl = `https://globalmenucdn.eu-central-1.production.jet-external.com/${restaurantSlug}_${countryCode}_itemDetails.json`;
    const menuApiUrl = `https://www.pyszne.${countryCode}/api/restaurants/${restaurantSlug}/menu`;
    console.log(`Fetching Pyszne items API: ${itemsApiUrl}`);
    console.log(`Fetching Pyszne details API: ${detailsApiUrl}`);
    console.log(`Fetching Pyszne menu API: ${menuApiUrl}`);
  
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Origin': `https://www.pyszne.${countryCode}`,
      'Referer': `https://www.pyszne.${countryCode}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      'X-Jet-Application': 'OneWeb',
      'Access-control-allow-credentials': 'true',
      'Access-control-allow-origin': `https://www.pyszne.${countryCode}`
    };
  
    // 4) Fetch items, details, and menu data
    let itemsResponse, detailsResponse, menuResponse;
    const maxRetries = 3;
    const s3KeysToDelete = [];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        itemsResponse = await axios.get(itemsApiUrl, { headers });
        if (itemsResponse.status === 200) {
          console.log('Items API response received');
          break;
        }
      } catch (error) {
        console.error(`Items API attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) throw new Error(`Failed to fetch Pyszne items API after ${maxRetries} attempts: ${error.message}`);
        await delay(2000 * Math.pow(2, attempt - 1));
      }
    }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        detailsResponse = await axios.get(detailsApiUrl, { headers });
        if (detailsResponse.status === 200) {
          console.log('Details API response received');
          break;
        }
      } catch (error) {
        console.error(`Details API attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) throw new Error(`Failed to fetch Pyszne details API after ${maxRetries} attempts: ${error.message}`);
        await delay(2000 * Math.pow(2, attempt - 1));
      }
    }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        menuResponse = await axios.get(menuApiUrl, { headers });
        if (menuResponse.status === 200) {
          console.log('Menu API response received');
          break;
        }
      } catch (error) {
        console.error(`Menu API attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) {
          console.warn(`Failed to fetch Pyszne menu API after ${maxRetries} attempts: ${error.message}`);
          menuResponse = { data: { categories: [] } }; // Fallback to empty categories
        }
        await delay(2000 * Math.pow(2, attempt - 1));
      }
    }
  
    const itemsData = itemsResponse.data;
    const detailsData = detailsResponse.data;
    const menuData = menuResponse.data;
    const items = itemsData.Items || [];
    const modifierGroups = detailsData.ModifierGroups || [];
    const menuGroups = menuData.categories || detailsData.MenuGroups || [];
    if (items.length === 0) {
      console.warn('No items found in response. Store may be closed or have no items.');
    }
  
    // 5) Map MenuGroupIds to category names
    const categoryMap = new Map();
    const categorySet = new Set();
    for (const menuGroup of menuGroups) {
      const categoryId = menuGroup.Id || menuGroup.id || '';
      const categoryName = normalizeText(menuGroup.Name || menuGroup.name || menuGroup.title || 'Unknown Category');
      categoryMap.set(categoryId, categoryName);
      categorySet.add(categoryName);
      console.log(`Mapped category ID ${categoryId} to name: ${categoryName}`);
    }
  
    // 6) Process items
    const dishes = [];
    const optionsList = [];
    const optionGroups = [];
    const usedIds = new Set();
    const usedOptionIds = new Map();
    const usedOptionGroupIds = new Map();
    let imageCount = 0;
    let optionCount = 0;
    let optionGroupCount = 0;
    const menuUrl = restaurantUrl.endsWith('/') ? restaurantUrl : `${restaurantUrl}/`;
  
    for (const item of items) {
      const itemId = item.Id || '';
      if (!itemId) continue;
      const variation = item.Variations && item.Variations.length > 0 ? item.Variations[0] : {};
      const menuGroupIds = variation.MenuGroupIds || [];
      let categoryName = 'Unknown Category';
      if (menuGroupIds.length > 0) {
        for (const menuGroupId of menuGroupIds) {
          if (categoryMap.has(menuGroupId)) {
            categoryName = categoryMap.get(menuGroupId);
            break;
          }
        }
      }
      categorySet.add(categoryName);
      const dishId = generateDishId(item.Name || item.Title, usedIds);
  
      // Image handling
      let imagePath = '';
      let imageAttachment = [];
      let imageUrl = item.ImageSources?.[0]?.Path || '';
      if (imageUrl && imageUrl.includes('{transformations}')) {
        imageUrl = imageUrl.replace('{transformations}', 'f_auto,w_512');
        console.log(`Transformed image URL for ${item.Name || item.Title}: ${imageUrl}`);
      }
      if (imageUrl && imageUrl.startsWith('http')) {
        console.log(`Attempting to download image for ${item.Name || item.Title}: ${imageUrl}`);
        const safeName = sanitizeFilename(item.Name || item.Title, true);
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        const maxBaseLength = 50 - (uniqueId.length + 5);
        const finalBaseName = safeName.substring(0, maxBaseLength);
        const filePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
        try {
          const downloadResult = await downloadImage(restaurantUrl, imageUrl, filePath, restaurantName, item.Name || item.Title);
          if (downloadResult && fsSync.existsSync(filePath)) {
            s3KeysToDelete.push(downloadResult.s3Key);
            const resizeResult = await resizeImage(downloadResult.s3Key, filePath, restaurantName, item.Name || item.Title);
            if (resizeResult) {
              imagePath = resizeResult.url;
              imageAttachment = [{ url: resizeResult.url, filename: resizeResult.filename }];
              imageCount++;
              console.log(`Image processed for ${item.Name || item.Title}: ${resizeResult.url}`);
            } else {
              console.warn(`Failed to resize image for ${item.Name || item.Title} from s3://synapseimage/${downloadResult.s3Key}`);
            }
          } else {
            console.warn(`Image download failed for ${item.Name || item.Title}: ${filePath}`);
          }
        } catch (error) {
          console.error(`Failed to process image for ${item.Name || item.Title}: ${error.message}`);
          await fs.unlink(filePath).catch(() => {});
        }
      } else {
        console.log(`No valid image URL for ${item.Name || item.Title}: ${imageUrl}`);
      }
  
      const price = cleanPrice((variation.BasePrice || 0).toFixed(2) || '0.00');
      const dishOptionGroupIds = [];
      dishes.push({
        id: dishId,
        category: categoryName,
        dishName: normalizeText(item.Name || item.Title || ''),
        price: price,
        description: normalizeText(item.Description || ''),
        image: imagePath,
        optionGroups: '',
        imageAttachment,
        dishNameEnUS: normalizeText(item.Name || item.Title || ''),
        descriptionEnUS: normalizeText(item.Description || '')
      });
  
      // Process additions (options)
      const itemAdditions = item.additions || [];
      for (const addition of itemAdditions) {
        const optionGroupName = normalizeText(addition.groupName || '');
        if (!optionGroupName) continue;
        const isCounterType = optionGroupName.toLowerCase().includes('sos') || optionGroupName.toLowerCase().includes('dodatki');
        const optionGroupType = isCounterType ? 'counter' : addition.maxChoices > 1 ? 'multi_select' : 'single_select';
        let optionGroupId;
        if (!usedOptionGroupIds.has(optionGroupName)) {
          usedOptionGroupIds.set(optionGroupName, `optionGroup${++optionGroupCount}`);
          optionGroupId = usedOptionGroupIds.get(optionGroupName);
          const optionGroupMin = addition.minChoices || 0;
          const optionGroupMax = addition.maxChoices || 0;
          const optionGroupEachMax = optionGroupType === 'counter' ? 10 : 1;
          const optionIds = [];
          const options = addition.modifiers || [];
          for (const option of options) {
            const price = cleanPrice((option.Price || 0).toFixed(2) || '0.00');
            const optionName = normalizeText(option.Name || '');
            if (!optionName) continue;
            const optionKey = `${optionName}:${price}`;
            const isFree = parseFloat(price) === 0;
            let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
            if (usedOptionIds.has(optionKey)) {
              optionId = usedOptionIds.get(optionKey);
              if (!optionIds.includes(optionId)) {
                optionIds.push(optionId);
              }
              continue;
            }
            usedOptionIds.set(optionKey, optionId);
            optionsList.push({
              optionId: optionId,
              price: price,
              name: optionName,
              translatedItemName: '',
              optionGroups: optionGroupId,
              extrasId: option.ModifierId || '',
              isFree: isFree
            });
            optionIds.push(optionId);
            optionCount++;
          }
          if (optionIds.length > 0) {
            optionGroups.push({
              optionGroupId: optionGroupId,
              name: optionGroupName,
              nameEnUS: '',
              optionGroupType: optionGroupType,
              optionGroupMin: optionGroupMin,
              optionGroupMax: optionGroupMax,
              optionGroupEachMax: optionGroupEachMax,
              dishUrl: `${menuUrl}${itemId}`,
              options: [...new Set(optionIds)],
              dishes: [dishId]
            });
            dishOptionGroupIds.push(optionGroupId);
          }
        } else {
          optionGroupId = usedOptionGroupIds.get(optionGroupName);
          const existingOptionGroup = optionGroups.find(og => og.optionGroupId === optionGroupId);
          if (existingOptionGroup && !existingOptionGroup.dishes.includes(dishId)) {
            existingOptionGroup.dishes.push(dishId);
            dishOptionGroupIds.push(optionGroupId);
            const optionIds = [];
            const options = addition.modifiers || [];
            for (const option of options) {
              const price = cleanPrice((option.Price || 0).toFixed(2) || '0.00');
              const optionName = normalizeText(option.Name || '');
              if (!optionName) continue;
              const optionKey = `${optionName}:${price}`;
              const isFree = parseFloat(price) === 0;
              let optionId = `${sanitizeFilename(optionName, true)}-option${isFree ? '-free' : '-paid'}`;
              if (usedOptionIds.has(optionKey)) {
                optionId = usedOptionIds.get(optionKey);
                if (!optionIds.includes(optionId) && !existingOptionGroup.options.includes(optionId)) {
                  optionIds.push(optionId);
                  existingOptionGroup.options.push(optionId);
                }
                continue;
              }
              usedOptionIds.set(optionKey, optionId);
              optionsList.push({
                optionId: optionId,
                price: price,
                name: optionName,
                translatedItemName: '',
                optionGroups: optionGroupId,
                extrasId: option.ModifierId || '',
                isFree: isFree
              });
              optionIds.push(optionId);
              existingOptionGroup.options.push(optionId);
              optionCount++;
            }
            existingOptionGroup.options = [...new Set(existingOptionGroup.options)];
          }
        }
      }
      dishes.find(d => d.id === dishId).optionGroups = dishOptionGroupIds.join(', ');
    }
  
    // 7) Clean up toResize/ images
    if (s3KeysToDelete.length > 0) {
      await cleanS3ToResize(restaurantName, s3KeysToDelete);
    }
  
    // 8) Log contents of /tmp/output/<restaurantName>/pics after processing
    try {
      const imageFiles = await fs.readdir(outputDir).catch(() => []);
      console.log(`Images in ${outputDir} after processing: ${imageFiles.join(', ')}`);
    } catch (error) {
      console.error(`Failed to list images in ${outputDir}: ${error.message}`);
    }
  
    // Add a delay to ensure all S3 operations are complete
    console.log('Waiting 2 seconds to ensure S3 operations are complete...');
    await delay(2000);
  
    // Log contents again before CSV writing
    try {
      const imageFiles = await fs.readdir(outputDir).catch(() => []);
      console.log(`Images in ${outputDir} before CSV writing: ${imageFiles.join(', ')}`);
    } catch (error) {
      console.error(`Failed to list images in ${outputDir} before CSV writing: ${error.message}`);
    }
  
    // 9) Save raw JSON
    console.log(`Extracted ${dishes.length} dishes, ${categorySet.size} categories, ${imageCount} images, ${optionCount} options, ${optionGroupCount} option groups`);
    if (dishes.length > 0) console.log('Sample dish:', dishes[0]);
    if (optionGroups.length > 0) console.log('Sample option group:', optionGroups[0]);
    if (optionsList.length > 0) console.log('Sample option:', optionsList[0]);
  
    const rawData = { dishes, options: optionsList, optionGroups };
    await fs.writeFile(path.join('/tmp', 'output', `${restaurantName}_raw.json`), JSON.stringify(rawData, null, 2), 'utf8');
    console.log(`Raw JSON saved: /tmp/output/${restaurantName}_raw.json`);
  
    return {
      dishes,
      options: optionsList,
      optionGroups,
      startTime: Date.now(),
      counters: {
        dishes: dishes.length,
        categories: categorySet.size,
        images: imageCount,
        options: optionCount,
        optionGroups: optionGroupCount,
        tags: 0
      }
    };
  }

async function scrapeGeneralSite(page, restaurantUrl, restaurantName) {
    console.log('Starting independent restaurant scraping...');
    const outputDir = path.join('/tmp', 'output', restaurantName, 'pics');
    await ensureOutputDir(outputDir);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0.0.0 Safari/537.36');
    console.log(`Navigating to ${restaurantUrl}`);
    await page.goto(restaurantUrl, { waitUntil: 'networkidle2' });
    const startTime = Date.now();
    page.on('popup', async (popup) => {
        console.log(`Popup detected: URL=${popup.url()}, Time=${new Date().toISOString()}`);
        try {
            await popup.close();
            console.log(`Closed popup: ${popup.url()}`);
        } catch (error) {
            console.error(`Failed to close popup: ${popup.url()}: ${error.message}`);
        }
    });
    page.on('dialog', async (dialog) => {
        console.log(`Dialog detected: Type=${dialog.type()}, Message=${dialog.message()}, Time=${new Date().toISOString()}`);
        try {
            await dialog.dismiss();
            console.log('Dismissed dialog');
        } catch (error) {
            console.error(`Failed to dismiss dialog: ${error.message}`);
        }
    });
    await delay(10000);
    console.log('Scrolling to load content...');
    let scrollAttempts = 0;
    const maxScrollAttempts = 3;
    while (scrollAttempts < maxScrollAttempts) {
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 100;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 200);
                });
            });
            console.log('Scrolling completed');
            break;
        } catch (error) {
            scrollAttempts++;
            console.warn(`Scroll attempt ${scrollAttempts} failed: ${error.message}`);
            if (scrollAttempts === maxScrollAttempts) {
                console.error(`Failed to scroll: ${error.message}`);
                throw error;
            }
            await delay(2000);
        }
    }
    await delay(5000);
    console.log('Extracting menu data heuristically...');
    const rawMenuData = await page.evaluate(() => {
        const basicNormalize = (text) => (text ? text.trim() : '');
        const data = [];
        let currentCategory = 'Unknown Category';
        const menuContainers = document.querySelectorAll('#menu, div[class*="menu"], div[id*="menu"], ul[class*="menu"], section[class*="menu"], div[class*="dish"], div[class*="item"], div[class*="food"], div[class*="tabs"], div[class*="panel"], div[class*="header"], div[class*="section"], div[class*="list"]');
        menuContainers.forEach((container) => {
            const possibleCategories = container.querySelectorAll('h1, h2, h3, h4, h5, h6, div[class*="header"], div[class*="section"], div[class*="tabs-panel-container"] > div');
            possibleCategories.forEach((catNode) => {
                const catText = basicNormalize(catNode.textContent);
                if (catText && (catText.toUpperCase() === catText || catNode.className.includes('header') || catNode.className.includes('title') || catNode.className.includes('panel'))) {
                    currentCategory = catText;
                }
            });
            const itemNodes = container.querySelectorAll('li, div[class*="item"], div[class*="dish"], div[class*="product"], div[class*="grid"], div[class*="column"]');
            itemNodes.forEach((itemNode) => {
                const dishNameNode = itemNode.querySelector('h1, h2, h3, h4, h5, h6, span[class*="title"], div[class*="title"], span[class*="name"], div[class*="name"]');
                const dishName = basicNormalize(dishNameNode?.textContent || '');
                const priceNodes = itemNode.querySelectorAll('span[class*="price"], div[class*="price"], p[class*="price"], span, p, div');
                let priceRaw = '';
                priceNodes.forEach((node) => {
                    const text = basicNormalize(node.textContent);
                    if (/\d+[.,]\d+/.test(text) || /[\$€£]\d+/.test(text) || node.className.includes('price')) {
                        priceRaw = text;
                    }
                });
                const descNode = itemNode.querySelector('p, span[class*="desc"], div[class*="desc"], div[class*="info"], div[class*="description"], div:nth-child(2)');
                const description = basicNormalize(descNode?.textContent || '');
                const imgNode = itemNode.querySelector('div[class*="image"] > img, div[class*="img"] > img, figure > img, img');
                let image = '';
                if (imgNode) {
                    image = imgNode.src || '';
                    const alt = imgNode.alt?.toLowerCase() || '';
                    if (alt.includes('dish') || alt.includes('menu') || alt.includes('food') || imgNode.src.includes('menu') || imgNode.src.includes('dish')) {
                        image = imgNode.src;
                    }
                }
                if (dishName) {
                    data.push({ category: currentCategory, dishName, price: priceRaw, description, image });
                }
            });
        });
        console.log(`Extracted ${data.length} raw menu items heuristically`);
        return data;
    });
    const menuData = [];
    const usedIds = new Set();
    for (const item of rawMenuData) {
        let imagePath = '';
        if (item.image && item.image.startsWith('http')) {
            const safeName = sanitizeFilename(item.dishName);
            const uniqueId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            const maxBaseLength = 50 - (uniqueId.length + 5);
            const finalBaseName = safeName.substring(0, maxBaseLength);
            const filePath = path.join(outputDir, `${finalBaseName}-${uniqueId}.jpg`);
            try {
                await downloadImage(restaurantUrl, item.image, filePath);
                await resizeImage(filePath);
                imagePath = path.join('pics', `${finalBaseName}-${uniqueId}.jpg`);
            } catch (error) {
                console.error(`Failed to process image for ${item.dishName}: ${error.message}`);
                await fs.unlink(filePath).catch(() => {});
            }
        }
        const dishId = generateDishId(item.dishName, usedIds);
        menuData.push({
            id: dishId,
            category: normalizeText(item.category),
            dishName: normalizeText(item.dishName),
            price: cleanPrice(item.price),
            description: normalizeText(item.description),
            image: imagePath,
            optionGroups: ''
        });
    }
    console.log(`Extracted ${menuData.length} dishes heuristically`);
    if (menuData.length > 0) {
        console.log('Sample dish:', menuData[0]);
    } else {
        console.warn('No menu items found heuristically - site may not match patterns');
    }
    console.log(`Navigation and extraction complete for ${restaurantUrl}`);
    return { dishes: menuData, optionGroups: [], startTime };
}

async function resizeImage(filePath) {
    const maxRetries = 3;
    let attempt = 1;
    while (attempt <= maxRetries) {
        try {
            await sharp(filePath)
                .resize({ height: 1200, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
                .jpeg({ quality: 80 })
                .toFile(filePath + '.tmp');
            await delay(100);
            console.log(`Attempt ${attempt} to rename ${filePath}.tmp to ${filePath}`);
            await fs.rename(filePath + '.tmp', filePath);
            await fs.chmod(filePath, 0o644).catch(err => console.warn(`Failed to set permissions for ${filePath}: ${err.message}`));
            console.log(`Successfully resized ${filePath}, filename length: ${path.basename(filePath).length}`);
            return;
        } catch (error) {
            console.error(`Resize attempt ${attempt} failed: ${filePath}: ${error.message}`);
            if (attempt === maxRetries) {
                throw new Error(`Failed to resize ${filePath} after ${maxRetries} attempts: ${error.message}`);
            }
            await delay(1000 * Math.pow(2, attempt - 1));
            attempt++;
        }
    }
}

async function downloadImage(restaurantUrl, url, filePath, restaurantName, dishName) {
    const maxRetries = 3;
    let attempt = 1;
    // Resolve relative URLs
    let resolvedUrl = url;
    if (!url.startsWith('http')) {
        try {
            resolvedUrl = new URL(url, restaurantUrl).toString();
        } catch (error) {
            console.error(`Failed to resolve URL ${url} against ${restaurantUrl}: ${error.message}`);
            throw new Error(`Invalid image URL: ${url}`);
        }
    }
    while (attempt <= maxRetries) {
        try {
            console.log(`Attempt ${attempt} to download ${resolvedUrl} to ${filePath}`);
            const response = await axios.get(resolvedUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                    'Referer': restaurantUrl,
                    'Accept': 'image/jpeg,image/png,image/*,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });
            if (response.status === 200) {
                await fs.writeFile(filePath, Buffer.from(response.data));
                console.log(`Downloaded ${path.basename(filePath)}`);
                if (fsSync.existsSync(filePath)) {
                    // Upload original image to s3://synapseimage/toResize/
                    const bucketName = 'synapseimage';
                    const sanitizedDishName = sanitizeFilename(dishName, true);
                    const toResizeKey = `toResize/${restaurantName}/${sanitizedDishName}-${Date.now()}.jpg`;
                    const fileContent = await fs.readFile(filePath);
                    const params = {
                        Bucket: bucketName,
                        Key: toResizeKey,
                        Body: fileContent,
                        ContentType: 'image/jpeg',
                    };
                    const data = await s3.upload(params).promise();
                    console.log(`Uploaded original image for ${dishName} to s3://${bucketName}/${toResizeKey}`);
                    return { localPath: filePath, s3Key: toResizeKey };
                } else {
                    throw new Error(`File not found after download: ${filePath}`);
                }
            } else {
                throw new Error(`Failed to fetch image: HTTP ${response.status}`);
            }
        } catch (error) {
            console.error(`Error downloading ${resolvedUrl} (attempt ${attempt}): ${error.message}`);
            if (attempt === maxRetries) {
                console.warn(`Failed to download ${resolvedUrl} after ${maxRetries} attempts`);
                return null;
            }
            await delay(1000 * Math.pow(2, attempt - 1));
            attempt++;
        }
    }
    return null;
}

async function resizeImage(s3Key, localPath, restaurantName, dishName) {
    const maxRetries = 3;
    let attempt = 1;
    const bucketName = 'synapseimage';
    // Download from s3://synapseimage/toResize/
    while (attempt <= maxRetries) {
        try {
            console.log(`Attempt ${attempt} to download from s3://${bucketName}/${s3Key} to ${localPath}`);
            const s3Response = await s3.getObject({ Bucket: bucketName, Key: s3Key }).promise();
            await fs.writeFile(localPath, s3Response.Body);
            console.log(`Downloaded ${s3Key} to ${localPath}`);
            break;
        } catch (error) {
            console.error(`Error downloading from S3 ${s3Key} (attempt ${attempt}): ${error.message}`);
            if (attempt === maxRetries) {
                throw new Error(`Failed to download ${s3Key} after ${maxRetries} attempts: ${error.message}`);
            }
            await delay(1000 * Math.pow(2, attempt - 1));
            attempt++;
        }
    }
    // Resize the image
    attempt = 1;
    while (attempt <= maxRetries) {
        try {
            console.log(`Attempt ${attempt} to resize ${localPath}`);
            await sharp(localPath)
                .resize({ height: 1200, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
                .jpeg({ quality: 80 })
                .toFile(localPath + '.tmp');
            await delay(100);
            console.log(`Attempt ${attempt} to rename ${localPath}.tmp to ${localPath}`);
            await fs.rename(localPath + '.tmp', localPath);
            await fs.chmod(localPath, 0o644).catch(err => console.warn(`Failed to set permissions for ${localPath}: ${err.message}`));
            console.log(`Successfully resized ${localPath}, filename length: ${path.basename(localPath).length}`);
            // Upload resized image to s3://synapseimage/images/
            const sanitizedDishName = sanitizeFilename(dishName, true);
            const resizedKey = `images/${restaurantName}/${sanitizedDishName}-${Date.now()}.jpg`;
            const fileContent = await fs.readFile(localPath);
            const params = {
                Bucket: bucketName,
                Key: resizedKey,
                Body: fileContent,
                ContentType: 'image/jpeg',
                ACL: 'public-read' // Ensure public access
            };
            const data = await s3.upload(params).promise();
            const publicUrl = `https://${bucketName}.s3.amazonaws.com/${resizedKey}`;
            console.log(`Uploaded resized image for ${dishName}: ${publicUrl}`);
            return { url: publicUrl, filename: path.basename(resizedKey) };
        } catch (error) {
            console.error(`Resize attempt ${attempt} failed: ${localPath}: ${error.message}`);
            if (attempt === maxRetries) {
                throw new Error(`Failed to resize ${localPath} after ${maxRetries} attempts: ${error.message}`);
            }
            await delay(1000 * Math.pow(2, attempt - 1));
            attempt++;
        }
    }
}


async function startScraping(restaurantUrl, jobId) {
    // Where to upload
    const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || 'project-synapse-processed-data-vinesh';
    if (!OUTPUT_BUCKET) throw new Error('OUTPUT_BUCKET env var is required');

    let startTime = Date.now();
    let browser; // so we can close it in finally on errors too

    try {
        await createDynamoDBTableIfNotExists();

        // -------- resolve scraper + language + name --------
        let scraperFunction;
        let restaurantName;
        let sourceLang = 'en';

        const cleanRestaurantName = (name) => name.split('?')[0].toLowerCase();
        const getLanguageCode = (url) => {
            const pathMatch = url.match(/\/([a-z]{2})\//);
            if (pathMatch && supportedLanguages[pathMatch[1]]) return pathMatch[1];
            const domainMatch = url.match(/([a-z]{2})\.[a-z]+\//) || url.match(/\.([a-z]{2})$/);
            if (domainMatch && supportedLanguages[domainMatch[1]]) return domainMatch[1];
            return 'en';
        };

        if (restaurantUrl.includes('glovoapp.com')) {
            const parts = restaurantUrl.split('/').filter(Boolean);
            restaurantName = cleanRestaurantName(parts.pop() || 'unknown');
            scraperFunction = scrapeGlovo;
        } else if (restaurantUrl.includes('ubereats.com')) {
            restaurantName = cleanRestaurantName(restaurantUrl.split('/store/')[1]?.split('/')[0] || 'unknown');
            scraperFunction = scrapeUberEats;
        } else if (restaurantUrl.includes('wolt.com')) {
            restaurantName = cleanRestaurantName(restaurantUrl.split('/restaurant/')[1] || 'unknown');
            scraperFunction = scrapeWolt;
        } else if (restaurantUrl.includes('foodora.')) {
            restaurantName = cleanRestaurantName(restaurantUrl.split('/restaurant/')[1]?.split('/')[0] || 'unknown');
            scraperFunction = scrapeFoodora;
        } else if (restaurantUrl.includes('pyszne.pl')) {
            restaurantName = cleanRestaurantName(restaurantUrl.split('/restaurant/')[1]?.split('/')[1] || 'unknown');
            scraperFunction = scrapePyszne;
        } else if (restaurantUrl.includes('foody.com')) {
            restaurantName = cleanRestaurantName(restaurantUrl.split('/').pop() || 'unknown');
            scraperFunction = scrapeFoody;
        } else {
            restaurantName = cleanRestaurantName(new URL(restaurantUrl).hostname.replace('www.', ''));
            scraperFunction = scrapeGeneralSite;
        }
        sourceLang = getLanguageCode(restaurantUrl);
        console.log(`Language: ${sourceLang} (${supportedLanguages[sourceLang] || 'Unknown'}), Restaurant: ${restaurantName}`);

        // -------- paths --------
        const scrapeTimestamp = new Date().toISOString();
        const baseOut = '/tmp/output';
        const dishCsvPath = path.join(baseOut, `${restaurantName}_dishes.csv`);
        const optionGroupCsvPath = path.join(baseOut, `${restaurantName}_option_groups.csv`);
        const optionCsvPath = path.join(baseOut, `${restaurantName}_options.csv`);
        const jsonPath = path.join(baseOut, `${restaurantName}_raw.json`);
        const zipPath = path.join(baseOut, `${restaurantName}.zip`);
        const imageDir = path.join(baseOut, restaurantName, 'pics');

        await fs.mkdir(path.dirname(dishCsvPath), { recursive: true });

        // -------- browser --------
        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath("https://github.com/Sparticuz/chromium/releases/download/v127.0.0/chromium-v127.0.0-pack.tar"),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        const mainTarget = page.target();
        browser.on('targetcreated', async (t) => {
            if (t === mainTarget) return;
            try {
                const type = t.type();
                if (type === 'page' || type === 'other' || type === 'browser') {
                    const p = await t.page();
                    if (p) await p.close();
                }
            } catch (e) { console.warn('targetclose warn:', e.message); }
        });

        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        // -------- status: navigating --------
        await dynamoDb.update({
            TableName: 'ScrapeStatus',
            Key: { jobId: String(jobId) },
            UpdateExpression: 'SET #status = :s',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':s': 'navigating' }
        }).promise();

        // -------- scrape --------
        console.log('Reading menu…');
        const scrapeOut = await scraperFunction(page, restaurantUrl, restaurantName);
        const dishes = Array.isArray(scrapeOut?.dishes) ? scrapeOut.dishes : [];
        const optionGroups = Array.isArray(scrapeOut?.optionGroups) ? scrapeOut.optionGroups : [];
        const optionsList = Array.isArray(scrapeOut?.options) ? scrapeOut.options : [];
        const counters = scrapeOut?.counters || { dishes:0, categories:0, images:0, options:0, optionGroups:0, tags:0 };
        startTime = scrapeOut?.startTime || startTime;

        await dynamoDb.update({
            TableName: 'ScrapeStatus',
            Key: { jobId: String(jobId) },
            UpdateExpression: 'SET #status = :s, #counters = :c, #restaurantName = :rn',
            ExpressionAttributeNames: { '#status': 'status', '#counters': 'counters', '#restaurantName': 'restaurantName' },
            ExpressionAttributeValues: { ':s': 'reading_menu', ':c': counters, ':rn': restaurantName }
        }).promise();

        await page.close();

        // -------- translate --------
        await dynamoDb.update({
            TableName: 'ScrapeStatus',
            Key: { jobId: String(jobId) },
            UpdateExpression: 'SET #status = :s',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':s': 'translating' }
        }).promise();

        for (const d of dishes) {
            d.dishNameEnUS = await translateText(d.dishName, sourceLang);
            d.descriptionEnUS = await translateText(d.description, sourceLang);
        }
        for (const o of optionsList) {
            o.translatedItemName = await translateText(o.name, sourceLang);
        }
        for (const og of optionGroups) {
            og.nameEnUS = await translateText(og.name, sourceLang);
        }

        // -------- CSV/JSON --------
        await dynamoDb.update({
            TableName: 'ScrapeStatus',
            Key: { jobId: String(jobId) },
            UpdateExpression: 'SET #status = :s',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':s': 'saving_csv' }
        }).promise();

        const dishCsvWriter = createCsvWriter({
            path: dishCsvPath,
            header: [
                { id: 'id', title: 'ID' },
                { id: 'image', title: 'Image' },
                { id: 'category', title: 'Category' },
                { id: 'price', title: 'Price' },
                { id: 'dishName', title: 'Dish Name' },
                { id: 'dishNameEnUS', title: 'Dish Name en-US' },
                { id: 'description', title: 'Description' },
                { id: 'descriptionEnUS', title: 'Description en-US' },
                { id: 'tags', title: 'Tags' },
                { id: 'optionGroups', title: 'Option Groups' }
            ],
            encoding: 'utf8'
        });

        const optionGroupCsvWriter = createCsvWriter({
            path: optionGroupCsvPath,
            header: [
                { id: 'optionGroupId', title: 'Option Group ID' },
                { id: 'name', title: 'Name' },
                { id: 'nameEnUS', title: 'Name en-US' },
                { id: 'optionGroupType', title: 'Option_group_type' },
                { id: 'optionGroupMin', title: 'Option_group_min' },
                { id: 'optionGroupMax', title: 'Option_group_max' },
                { id: 'optionGroupEachMax', title: 'Option_group_eachMax' },
                { id: 'dishUrl', title: 'Dish URL' },
                { id: 'options', title: 'Options' },
                { id: 'dishes', title: 'Dishes' }
            ],
            encoding: 'utf8'
        });

        const optionCsvWriter = createCsvWriter({
            path: optionCsvPath,
            header: [
                { id: 'optionId', title: 'Option ID' },
                { id: 'price', title: 'Price' },
                { id: 'name', title: 'Name' },
                { id: 'translatedItemName', title: 'Name en-US' },
                { id: 'optionGroups', title: 'Option Groups' }
            ],
            encoding: 'utf8'
        });

        // Use S3 URLs from imageAttachment for the Image column
        await dishCsvWriter.writeRecords(dishes.map(d => ({
            id: d.id,
            image: d.imageAttachment.length > 0 ? d.imageAttachment[0].url : '',
            category: d.category,
            price: d.price,
            dishName: d.dishName,
            dishNameEnUS: d.dishNameEnUS,
            description: d.description,
            descriptionEnUS: d.descriptionEnUS,
            tags: d.tags ? d.tags.join(', ') : '',
            optionGroups: d.optionGroups
        })));
        await optionGroupCsvWriter.writeRecords(optionGroups.map(g => ({
            optionGroupId: g.optionGroupId,
            name: g.name,
            nameEnUS: g.nameEnUS,
            optionGroupType: g.optionGroupType,
            optionGroupMin: g.optionGroupMin,
            optionGroupMax: g.optionGroupMax,
            optionGroupEachMax: g.optionGroupEachMax,
            dishUrl: g.dishUrl,
            options: (g.options || []).join(', '),
            dishes: (g.dishes || []).join(', ')
        })));
        await optionCsvWriter.writeRecords(optionsList.map(o => ({
            optionId: o.optionId,
            price: o.price,
            name: o.name,
            translatedItemName: o.translatedItemName,
            optionGroups: o.optionGroups
        })));

        // Add BOMs
        const dishCsvContent = await fs.readFile(dishCsvPath, 'utf8');
        const optionGroupCsvContent = await fs.readFile(optionGroupCsvPath, 'utf8');
        const optionCsvContent = await fs.readFile(optionCsvPath, 'utf8');
        await fs.writeFile(dishCsvPath, '\uFEFF' + dishCsvContent, 'utf8');
        await fs.writeFile(optionGroupCsvPath, '\uFEFF' + optionGroupCsvContent, 'utf8');
        await fs.writeFile(optionCsvPath, '\uFEFF' + optionCsvContent, 'utf8');

        const rawData = { dishes, options: optionsList, optionGroups };
        await fs.writeFile(jsonPath, JSON.stringify(rawData, null, 2), 'utf8');

        // -------- ZIP --------
        await dynamoDb.update({
            TableName: 'ScrapeStatus',
            Key: { jobId: String(jobId) },
            UpdateExpression: 'SET #status = :s',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':s': 'uploading_s3' }
        }).promise();

        const zip = new AdmZip();
        zip.addLocalFile(dishCsvPath);
        zip.addLocalFile(optionGroupCsvPath);
        zip.addLocalFile(optionCsvPath);
        zip.addLocalFile(jsonPath);
        if (fsSync.existsSync(imageDir)) {
            zip.addLocalFolder(imageDir, `${restaurantName}_images`);
        }
        zip.writeZip(zipPath);
        console.log(`ZIP file created: ${zipPath}`);

        // -------- upload to S3 --------
        const dishesKey = `csv/${restaurantName}/${path.basename(dishCsvPath)}`;
        const optionGroupsKey = `csv/${restaurantName}/${path.basename(optionGroupCsvPath)}`;
        const optionsKey = `csv/${restaurantName}/${path.basename(optionCsvPath)}`;
        const rawJsonKey = `csv/${restaurantName}/${path.basename(jsonPath)}`;
        const zipKey = `zip/${restaurantName}.zip`;

        const uploads = await Promise.all([
            s3.upload({ Bucket: OUTPUT_BUCKET, Key: dishesKey, Body: fsSync.createReadStream(dishCsvPath), ContentType: 'text/csv' }).promise(),
            s3.upload({ Bucket: OUTPUT_BUCKET, Key: optionGroupsKey, Body: fsSync.createReadStream(optionGroupCsvPath), ContentType: 'text/csv' }).promise(),
            s3.upload({ Bucket: OUTPUT_BUCKET, Key: optionsKey, Body: fsSync.createReadStream(optionCsvPath), ContentType: 'text/csv' }).promise(),
            s3.upload({ Bucket: OUTPUT_BUCKET, Key: rawJsonKey, Body: fsSync.createReadStream(jsonPath), ContentType: 'application/json' }).promise(),
            s3.upload({ Bucket: OUTPUT_BUCKET, Key: zipKey, Body: fsSync.createReadStream(zipPath), ContentType: 'application/zip' }).promise()
        ]);

        // Build artifacts AFTER upload
        const artifacts = {
            bucket: OUTPUT_BUCKET,
            dishesKey,
            optionGroupsKey,
            optionsKey,
            rawJsonKey,
            zipKey,
            fileNames: {
                dishes: path.basename(dishesKey),
                optionGroups: path.basename(optionGroupsKey),
                options: path.basename(optionsKey),
                json: path.basename(rawJsonKey),
                zip: path.basename(zipKey),
            }
        };

        // -------- import to DBs --------
        await dynamoDb.update({
            TableName: 'ScrapeStatus',
            Key: { jobId: String(jobId) },
            UpdateExpression: 'SET #status = :s',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':s': 'importing' }
        }).promise();

        await importToDynamoDB(dishCsvPath, path.join(baseOut, restaurantName), restaurantName, sourceLang, restaurantUrl, scrapeTimestamp, optionGroupCsvPath, optionCsvPath);
        await importToAirtable(dishCsvPath, path.join(baseOut, restaurantName), restaurantName, sourceLang, restaurantUrl, scrapeTimestamp, optionGroupCsvPath, optionCsvPath);

        // -------- finalize status --------
        const s3CsvUrls = uploads.slice(0, 4).map(u => u.Location).join(', ');
        await dynamoDb.update({
            TableName: 'ScrapeStatus',
            Key: { jobId: String(jobId) },
            UpdateExpression: `
                SET #status = :done,
                    #result = :res,
                    #counters = :c,
                    #restaurantName = :rn,
                    #zipUrl = :zu,
                    #artifacts = :art,
                    outputBucket = :ob,
                    outputKey = :ok
            `,
            ExpressionAttributeNames: {
                '#status': 'status',
                '#result': 'result',
                '#counters': 'counters',
                '#restaurantName': 'restaurantName',
                '#zipUrl': 'zipUrl',
                '#artifacts': 'artifacts'
            },
            ExpressionAttributeValues: {
                ':done': 'completed',
                ':res': s3CsvUrls,
                ':c': counters,
                ':rn': restaurantName,
                ':zu': `s3://${OUTPUT_BUCKET}/${zipKey}`,
                ':art': artifacts,
                ':ob': OUTPUT_BUCKET,
                ':ok': zipKey
            }
        }).promise();

        // Return (useful if you call directly)
        return {
            message: 'Scraping complete! Check the output folder.',
            s3CsvUrls,
            zipUrl: `s3://${OUTPUT_BUCKET}/${zipKey}`,
            artifacts,
            counters: {
                dishes: counters.dishes,
                categories: counters.categories,
                images: counters.images,
                options: counters.options,
                optionGroups: counters.optionGroups,
                tags: counters.tags,
                restaurantName
            }
        };

    } catch (error) {
        console.error('Error:', error);
        await dynamoDb.update({
            TableName: 'ScrapeStatus',
            Key: { jobId: String(jobId) },
            UpdateExpression: 'SET #status = :e, #err = :msg',
            ExpressionAttributeNames: { '#status': 'status', '#err': 'error' },
            ExpressionAttributeValues: { ':e': 'error', ':msg': error.message || String(error) }
        }).promise();
        throw error;
    } finally {
        if (browser) try { await browser.close(); } catch {}
        if (startTime) {
            const mins = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
            console.log(`It took ${mins} minutes to scrape this website.`);
        }
    }
}
module.exports = { startScraping };