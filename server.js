// Modified server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const upload = multer({ dest: '/tmp/uploads' });
const fsPromises = require('fs').promises;
const { startScraping } = require('./twoButtons');
const { startResizing } = require('./resizeImages');
const awsServerlessExpress = require('aws-serverless-express');

const app = express();
app.use(express.json());

app.use(cors({
    origin: 'https://staging.d14psktc46d2yd.amplifyapp.com/', // Your Amplify domain
    methods: ['OPTIONS', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// Scrape endpoint
app.post('/api/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    try {
        const result = await startScraping(url);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Resize endpoint
app.post('/api/resize', upload.array('images'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No images uploaded' });
    }
    const folderPath = path.join('/tmp', 'pics');
    try {
        await fsPromises.mkdir(folderPath, { recursive: true });
        for (const file of req.files) {
            const newPath = path.join(folderPath, file.originalname);
            await fsPromises.rename(file.path, newPath);
        }
        const result = await startResizing(folderPath);
        // Optional cleanup: delete uploaded files after resize
        await fsPromises.rm(folderPath, { recursive: true, force: true });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const server = awsServerlessExpress.createServer(app);
exports.handler = (event, context) => {
    awsServerlessExpress.proxy(server, event, context);
};