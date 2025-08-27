# AWS-back-frontend

This is the code (partial code) for making an AWS project which requires LAMBDA <img width="1899" height="999" alt="2025-08-27 10_07_57-Greenshot" src="https://github.com/user-attachments/assets/07a36e27-683c-4125-9177-0993c2aa8aa7" />

A serverless web app for scraping restaurant menus, translating content, exporting CSVs/ZIPs, and bulk-resizing images.  
Frontend is a static single page (`index.html`) hosted behind **Amazon CloudFront**.  
Backend is a **Node.js** **AWS Lambda** behind **Amazon API Gateway**. Persistent state is stored in **Amazon DynamoDB** and artifacts are stored in **Amazon S3**.

---

## High‑Level Architecture

```
[Browser / CloudFront SPA]
        |
        | HTTPS (CORS)
        v
  [Amazon API Gateway]
        |
        v
   [AWS Lambda (Node.js)]
        |
        +--> [DynamoDB]  : Job status + metadata (table: ScrapeStatus)
        |
        +--> [S3]        : CSV exports, raw JSON, ZIP bundles, resized images
        |
        +--> [AWS Textract]* (optional, via @aws-sdk/client-textract)
        |
        +--> [3rd‑party APIs]* e.g. Google Translate, Airtable
```

> \* Optional integrations are enabled only when corresponding credentials/config are provided.

---

## Repository Layout

```
.
├── index.html               # Frontend SPA that calls the API Gateway endpoints
├── server.js                # Express app adapted for Lambda via aws-serverless-express
├── lambda_handler.js        # Primary Lambda handler (async job orchestration + REST API)
├── twoButtons.js            # Core scraping, parsing, translation, CSV export, S3/DynamoDB updates
├── resizeImages.js          # Bulk image resize + (optional) upload to S3
├── images/                  # (local) input images helper folder
├── output/                  # (local) output folder (CSV/JSON/ZIP) when running outside AWS
├── client-textract/         # (placeholder for Textract client usage)
├── robots.txt
├── package.json / lock
└── .env                     # (optional) local overrides — don't commit secrets
```

---

## Backend — API

`lambda_handler.js` exposes a small REST surface via API Gateway. All routes support CORS (`OPTIONS` preflight is handled).

### Base URL

```
https://<api-or-cloudfront-domain>/<stage>/scraper-function
```

In `index.html` this is referenced as `API_BASE`. Replace with your distribution/API endpoint.

### Endpoints

#### 1) Start a scrape (async)
```
POST {API_BASE}/start
Content-Type: application/json

{
  "url": "https://example-restaurant.tld/menu"
}
```
**Response**
```json
{ "message": "Scrape queued", "jobId": "<uuid>" }
```
A background run is triggered by self‑invoking the same Lambda (`InvocationType: "Event"`).

#### 2) Check job status
```
GET {API_BASE}/status?jobId=<uuid>
```
**Response (examples)**
```json
{ "jobId": "...", "status": "queued" }
{ "jobId": "...", "status": "running", "progress": {...} }
{ "jobId": "...", "status": "done", "artifacts": { "bucket": "...", "dishesKey": "...", "optionsKey": "...", "optionGroupsKey": "...", "rawJsonKey": "..." }, "outputKey": "zip/....zip", "outputBucket": "..." }
{ "jobId": "...", "status": "error", "error": "..." }
```

#### 3) Download final ZIP (pre‑signed)
```
GET {API_BASE}/download?jobId=<uuid>
```
Returns a pre‑signed S3 URL to the final ZIP, or a previously recorded URL if present.

#### 4) Get individual artifact links (pre‑signed)
```
GET {API_BASE}/artifacts?jobId=<uuid>
```
**Response**
```json
{
  "files": [
    { "label": "Dishes CSV",        "url": "https://s3..." },
    { "label": "Option Groups CSV", "url": "https://s3..." },
    { "label": "Options CSV",       "url": "https://s3..." },
    { "label": "Raw JSON",          "url": "https://s3..." }
  ]
}
```

> There is also an Express adapter (`server.js`) exposing `/scrape` and `/resize` POST endpoints (multipart/form‑data) when running the app as an Express server. In Lambda, `aws-serverless-express` wraps the app and exports `handler`.

---

## Async Job Model

1. `POST /start` validates input, creates a `jobId`, and **writes** an item to DynamoDB table `ScrapeStatus` with status `queued`.
2. Lambda **self‑invokes** asynchronously with `{"_action": "run", "url": "...", "jobId": "..."}`.
3. The scrape runs inside `twoButtons.js` (Puppeteer(-core), optional stealth plugin, parsing, translation, Sharp-based image ops).
4. Artifacts are written to S3 (CSVs + raw JSON, and optionally a ZIP). Keys and bucket are recorded back into DynamoDB.
5. Status is updated to `done` (or `error` with the message).

The frontend polls `/status` every few seconds and reveals download links once the job is finished.

---

## Data Storage

### DynamoDB (table: `ScrapeStatus`)

- **PK**: `jobId` (string)
- **Attributes (examples)**:  
  `status` (`queued|running|done|error`), `url`, `createdAt`, `error`, `artifacts` (S3 bucket + keys), `outputBucket`, `outputKey`, counters/metrics.

### Amazon S3

Suggested prefixes (exact keys set at runtime):
```
s3://<ARTIFACTS_BUCKET>/{jobId}/
  ├── dishes.csv
  ├── options.csv
  ├── option_groups.csv
  ├── raw.json
  └── bundle.zip           # optional combined ZIP
s3://<RESIZED_BUCKET>/...  # outputs from /resize flow (if used)
```

---

## Frontend

The SPA (`index.html`) presents a URL input and progress UI. It calls the four API endpoints above and reveals links to S3 artifacts on completion. Host it from an S3 bucket with CloudFront in front:
- **Origin**: S3 static site (or S3 origin with OAC).
- **Cache Policy**: `CachingDisabled` or short TTLs for HTML to pick up new deployments.
- **Env**: edit `API_BASE` in `index.html` to your API Gateway base path.

---

## Security & Networking

- **CORS**: Lambda responds with:
  - `Access-Control-Allow-Origin: <request Origin> or *`
  - `Access-Control-Allow-Methods: GET, POST, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type, Authorization`
  - `Access-Control-Allow-Credentials: true`
- **IAM (least privilege)** for the Lambda execution role:
  - `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on specific buckets/prefixes.
  - `dynamodb:PutItem`, `GetItem`, `UpdateItem`, `Query` on the `ScrapeStatus` table.
  - `lambda:InvokeFunction` on **self** (for async re‑invocation).
  - If using **Textract**: the necessary `textract:*` permissions.
- **Secrets**:
  - Avoid embedding secrets in code. Use Lambda **environment variables** or a secrets manager.
  - For **Google Translate** (`@google-cloud/translate`), provide a service account credential path/JSON via env var and bundle appropriately.
  - For **Airtable**, supply API key/base ID via environment variables.
- **Network**: Typically **no VPC** is required unless your target sites or egress controls demand it. If placing the Lambda in a VPC, add NAT for outbound web access (Puppeteer/HTTP, S3, DynamoDB).

---

## Local Development

This project is optimized for Lambda, but you have options:

### 1) Invoke the Lambda handler locally
Use AWS SAM or your preferred local Lambda runner to invoke `lambda_handler.js` with mock API Gateway events.

### 2) Run the Express adapter
`server.js` uses `aws-serverless-express` to export a Lambda handler, but it also boots an Express app that exposes:
- `POST /scrape` with JSON `{ "url": "..." }` — triggers `startScraping()` synchronously.
- `POST /resize` (multipart/form‑data) — upload images for local/S3 resizing via `sharp`.

> Note: When running locally, ensure you have appropriate AWS credentials or disable S3/DynamoDB paths in code for pure local testing.

---

## Dependencies (selected)

- **Runtime**: Node.js (Lambda compatible), Express, aws-serverless-express
- **AWS SDKs**: `aws-sdk@v2`, `@aws-sdk/client-textract@v3`
- **Scraping**: `puppeteer-core` or `rebrowser-puppeteer-core` + `puppeteer-extra-plugin-stealth`
- **Images**: `sharp`
- **Data**: `csv-writer`, `csv-parse`, `axios`
- **Storage/Zip**: `archiver`, `adm-zip`
- **Utils**: `uuid`, `multer`, `cors`
- **Optional**: `@google-cloud/translate`, `airtable`

See `package.json` for exact versions.

---

## Deployment (example outline)

1. **Create resources**:
   - S3 bucket(s) for artifacts and (optionally) for the frontend.
   - DynamoDB table `ScrapeStatus` (PK `jobId` as a String).
   - Lambda function (Node.js 18+), with the code from this repo (bundle `node_modules` or use layers).
   - API Gateway (HTTP API or REST API) mapping to the Lambda with routes:
     - `POST /start`, `GET /status`, `GET /download`, `GET /artifacts`, plus `OPTIONS` for all.
   - CloudFront distribution with the S3 site as origin (and OAC if using S3 origin access).

2. **Configure environment**:
   - Set environment variables for bucket names, table name, and any third‑party keys/paths.
   - Grant the Lambda execution role the **least privileges** listed above.

3. **Build & upload**:
   - Zip the Lambda sources including `node_modules` (or build with a CI/CD step).
   - Upload to Lambda; update API routes/stage; deploy.

4. **Frontend**:
   - Update `API_BASE` in `index.html` to your API Gateway base path.
   - Upload `index.html` (and assets) to the S3 website bucket.
   - Invalidate CloudFront to propagate the new HTML quickly.

---

## Request Examples

```bash
# 1) Start a scrape
curl -X POST "{API_BASE}/start"   -H "Content-Type: application/json"   -d '{"url":"https://example-restaurant.tld/menu"}'

# 2) Poll status
curl "{API_BASE}/status?jobId=<uuid>"

# 3) Get final ZIP
curl -L "{API_BASE}/download?jobId=<uuid>" -o output.zip

# 4) Get individual artifacts
curl "{API_BASE}/artifacts?jobId=<uuid>"
```

---
