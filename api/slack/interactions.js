import { selectDeveloper, getTargetUrl, proxyRequest, updateStats, isDuplicateRequest } from '../_lib/load-balancer.js';

// Configure for raw body handling
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Check for duplicate requests
    if (isDuplicateRequest(req)) {
      console.log(`[INTERACTIONS] Returning cached response for duplicate request`);
      return res.status(200).json({ message: 'OK', cached: true });
    }
    
    // Get raw body for Slack signature verification
    const rawBody = await getRawBody(req);
    const body = rawBody.toString();
    
    // Handle both JSON and URL-encoded form data
    let jsonBody;
    try {
      // Try to parse as JSON first
      jsonBody = JSON.parse(body);
    } catch (jsonError) {
      // If JSON fails, try URL-encoded form data
      try {
        const urlParams = new URLSearchParams(body);
        const payload = urlParams.get('payload');
        if (payload) {
          jsonBody = JSON.parse(payload);
        } else {
          throw new Error('No payload found in form data');
        }
      } catch (formError) {
        console.error('Failed to parse body as JSON or form data:', body.substring(0, 100));
        return res.status(400).json({
          error: 'Invalid request body format',
          message: 'Expected JSON or URL-encoded form data'
        });
      }
    }
    
    // Select developer using load balancing
    const selectedDeveloper = selectDeveloper('slack_app');
    
    if (!selectedDeveloper) {
      return res.status(503).json({ 
        error: 'No available developers',
        service: 'slack_app'
      });
    }
    
    console.log(`Load balancing Slack interaction to developer: ${selectedDeveloper}`);
    
    // Get target URL
    const targetUrl = getTargetUrl(selectedDeveloper, 'slack_app');
    if (!targetUrl) {
      return res.status(502).json({ 
        error: 'No target URL found for developer and service',
        developer: selectedDeveloper,
        service: 'slack_app'
      });
    }
    
    // Create a modified request object with raw body
    const modifiedReq = {
      method: req.method,
      headers: req.headers,
      body: jsonBody, // For our proxy function
      rawBody: body   // For Slack signature verification
    };
    
    // Proxy the request
    try {
      // Ensure proper URL construction without double slashes
      const baseUrl = targetUrl.endsWith('/') ? targetUrl.slice(0, -1) : targetUrl;
      const fullUrl = `${baseUrl}/slack/interactions`;
      
      const result = await proxyRequest(modifiedReq, fullUrl);
      updateStats(selectedDeveloper);
      
      return res.status(result.status).json(result.data);
    } catch (proxyError) {
      return res.status(proxyError.status).json({
        error: proxyError.error,
        message: proxyError.message,
        developer: selectedDeveloper,
        duration_ms: proxyError.duration
      });
    }
    
  } catch (error) {
    console.error('Error in Slack interactions handler:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
}

// Helper function to get raw body
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(Buffer.from(data));
    });
    req.on('error', reject);
  });
} 