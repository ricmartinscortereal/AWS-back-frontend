// lambda_handler.js
const AWS = require('aws-sdk');
const { startScraping } = require('./twoButtons');

const dynamoDb = new AWS.DynamoDB.DocumentClient({ region: 'eu-north-1' });
const s3 = new AWS.S3();
const lambda = new AWS.Lambda();

exports.handler = async (event) => {
  // ----- Internal async trigger (self-invocation, NOT API Gateway) -----
  if (event && event._action === 'run' && event.url && event.jobId) {
    try {
      await startScraping(event.url, event.jobId);
    } catch (err) {
      console.error('Async run error:', err);
      try {
        await dynamoDb.update({
          TableName: 'ScrapeStatus',
          Key: { jobId: String(event.jobId) },
          UpdateExpression: 'set #status = :error, #errMsg = :msg',
          ExpressionAttributeNames: { '#status': 'status', '#errMsg': 'error' },
          ExpressionAttributeValues: { ':error': 'error', ':msg': err.message },
        }).promise();
      } catch (markErr) {
        console.error('Failed to mark error status in DynamoDB:', markErr);
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ----- API Gateway / CloudFront HTTP shape -----
  const origin = event.headers?.origin || '*';
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };

  try {
    // --- CORS preflight ---
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ message: 'CORS preflight successful.' }) };
    }

    const path = (event.path || '').toLowerCase();
    const qs = event.queryStringParameters || {};

    // --- GET /download?jobId=... -> presigned URL for final ZIP or recorded URL ---
    if (event.httpMethod === 'GET' && path.endsWith('/download')) {
      const jobId = qs.jobId;
      if (!jobId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing jobId' }) };

      const result = await dynamoDb.get({ TableName: 'ScrapeStatus', Key: { jobId } }).promise();
      const item = result.Item;
      if (!item) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Job not found' }) };

      const outputKey = item.outputKey || item.zipKey;
      const bucket = item.outputBucket;

      if ((!outputKey || !bucket) && item.zipUrl) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ downloadUrl: item.zipUrl }) };
      }
      if (!outputKey || !bucket) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'No downloadable artifact recorded for this job' }) };
      }

      const presigned = await s3.getSignedUrlPromise('getObject', { Bucket: bucket, Key: outputKey, Expires: 60 * 15 });
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ downloadUrl: presigned }) };
    }

    // --- GET /artifacts?jobId=... -> presigned URLs for CSV/JSON files ---
    if (event.httpMethod === 'GET' && path.endsWith('/artifacts')) {
      const jobId = qs.jobId;
      if (!jobId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing jobId' }) };

      const result = await dynamoDb.get({ TableName: 'ScrapeStatus', Key: { jobId } }).promise();
      const item = result.Item;

      if (!item || !item.artifacts || !item.artifacts.bucket) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Artifacts not found' }) };
      }

      const { bucket, dishesKey, optionGroupsKey, optionsKey, rawJsonKey } = item.artifacts;
      const makeUrl = (Key) => s3.getSignedUrlPromise('getObject', { Bucket: bucket, Key, Expires: 60 * 15 });

      const [dishesUrl, optionGroupsUrl, optionsUrl, rawJsonUrl] = await Promise.all([
        makeUrl(dishesKey),
        makeUrl(optionGroupsKey),
        makeUrl(optionsKey),
        makeUrl(rawJsonKey),
      ]);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          files: [
            { label: 'Dishes CSV', url: dishesUrl },
            { label: 'Option Groups CSV', url: optionGroupsUrl },
            { label: 'Options CSV', url: optionsUrl },
            { label: 'Raw JSON', url: rawJsonUrl },
          ],
        }),
      };
    }

    // --- GET /?jobId=... -> poll job status (now includes artifacts info) ---
    if (event.httpMethod === 'GET' && qs.jobId) {
      const jobId = qs.jobId;
      try {
        const result = await dynamoDb.get({ TableName: 'ScrapeStatus', Key: { jobId } }).promise();
        if (!result.Item) {
          return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ status: 'error', error: 'Job not found' }) };
        }

        const item = result.Item;

        // NEW: build simple artifact summary for the UI (folder URI + filenames)
        let artifactsInfo = null;
        try {
          if (item.artifacts && item.artifacts.bucket) {
            const { bucket, dishesKey, optionGroupsKey, optionsKey, rawJsonKey } = item.artifacts;
            const firstKey = dishesKey || optionGroupsKey || optionsKey || rawJsonKey || '';
            const lastSlash = firstKey.lastIndexOf('/') + 1;
            const prefix = lastSlash > 0 ? firstKey.slice(0, lastSlash) : '';
            const s3FolderUri = prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}/`;

            artifactsInfo = {
              bucket,
              prefix,
              s3FolderUri,
              fileNames: {
                dishes: dishesKey ? dishesKey.split('/').pop() : null,
                options: optionsKey ? optionsKey.split('/').pop() : null,
                optionGroups: optionGroupsKey ? optionGroupsKey.split('/').pop() : null,
                json: rawJsonKey ? rawJsonKey.split('/').pop() : null,
              },
            };
          }
        } catch (e) {
          console.error('Error computing artifacts info:', e);
        }

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            status: item.status,
            error: item.error || null,
            presignedUrl: item.presignedUrl || null,
            outputKey: item.outputKey || null,
            zipUrl: item.zipUrl || null,
            counters: item.counters || null,
            restaurantName: item.restaurantName || null,
            artifacts: artifactsInfo, // <--- NEW
          }),
        };
      } catch (error) {
        console.error('Error fetching job status:', error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ status: 'error', error: error.message }) };
      }
    }

    // --- POST / -> enqueue job and return jobId immediately ---
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const url = body.url;
      if (!url) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing URL in request body' }) };

      const jobId = require('uuid').v4();
      console.log(`Generated jobId: ${jobId} for URL: ${url}`);

      // 1) Store initial job status so UI can poll immediately
      try {
        await dynamoDb.put({
          TableName: 'ScrapeStatus',
          Item: {
            jobId,
            status: 'queued',
            url,
            createdAt: new Date().toISOString(),
            error: null,
          },
        }).promise();
        console.log(`Stored initial job status in DynamoDB for jobId: ${jobId}`);
      } catch (error) {
        console.error(`Failed to store initial job status for jobId: ${jobId}`, error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `Failed to initialize job: ${error.message}`, jobId }) };
      }

      // 2) Invoke this same Lambda asynchronously to run the scrape
      try {
        await lambda.invoke({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: JSON.stringify({ _action: 'run', url, jobId }),
        }).promise();

        // 3) Respond immediately
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ message: 'Scrape queued', jobId }) };
      } catch (error) {
        console.error(`Failed to enqueue scrape for jobId: ${jobId}`, error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `Failed to enqueue scrape: ${error.message}`, jobId }) };
      }
    }

    // --- Fallback ---
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid request method or route' }) };
  } catch (error) {
    console.error('Lambda handler error:', error);

    let jobId = event.queryStringParameters?.jobId || 'unknown';
    if (event.body) {
      try {
        const body = JSON.parse(event.body || '{}');
        if (body.jobId) jobId = body.jobId;
      } catch (parseError) {
        console.error('Error parsing event.body for jobId:', parseError);
      }
    }

    try {
      if (jobId && jobId !== 'unknown') {
        await dynamoDb.update({
          TableName: 'ScrapeStatus',
          Key: { jobId },
          UpdateExpression: 'set #status = :error, #errMsg = :msg',
          ExpressionAttributeNames: { '#status': 'status', '#errMsg': 'error' },
          ExpressionAttributeValues: { ':error': 'error', ':msg': error.message },
        }).promise();
      }
    } catch (dynamoError) {
      console.error('Error updating DynamoDB with failure:', dynamoError);
    }

    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message, jobId }) };
  }
};
