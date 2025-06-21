const { Readable } = require('stream');

/**
 * A middleware to handle CORS.
 * Vercel automatically adds some CORS headers, but being explicit is better.
 * @param {function} fn The handler function to wrap.
 */
const allowCors = (fn) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // Allow any origin
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  return await fn(req, res);
};

/**
 * The main serverless function handler.
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // --- Step 1: Get secrets from Vercel Environment Variables ---
    const { OPENROUTER_API_KEY, TURNSTILE_SECRET_KEY } = process.env;

    if (!OPENROUTER_API_KEY || !TURNSTILE_SECRET_KEY) {
      console.error("Server configuration error: Missing environment variables.");
      return res.status(500).json({ error: 'Server configuration error.' });
    }

    // Vercel automatically parses the JSON body of the request.
    const { turnstileToken, ...apiRequestBody } = req.body;

    // --- Step 2: Verify the Turnstile token ---
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const turnstileFormData = new URLSearchParams();
    turnstileFormData.append('secret', TURNSTILE_SECRET_KEY);
    turnstileFormData.append('response', turnstileToken);
    if (ip) {
      turnstileFormData.append('remoteip', ip);
    }

    const turnstileResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: turnstileFormData,
    });

    const turnstileData = await turnstileResponse.json();
    if (!turnstileData.success) {
      console.error('Turnstile verification failed:', turnstileData['error-codes']);
      return res.status(403).json({ error: 'Turnstile verification failed.', codes: turnstileData['error-codes'] });
    }

    // --- Step 3: Forward the request to OpenRouter ---
    const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://jobhelp.online', // As required by OpenRouter
        'X-Title': encodeURIComponent('职业指南针'),
      },
      body: JSON.stringify(apiRequestBody),
    });

    // --- Step 4: Stream or send the response back to the client ---
    if (apiRequestBody.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // Important for Vercel to not buffer the response
      });
      // Pipe the web stream from fetch() to the Node.js response object
      Readable.fromWeb(openRouterResponse.body).pipe(res);
    } else {
      // Handle non-streaming response
      res.status(openRouterResponse.status).json(await openRouterResponse.json());
    }

  } catch (error) {
    console.error('Error in /api/analyze:', error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
}

module.exports = allowCors(handler); 