import { selectDeveloper, getTargetUrl, proxyRequest, updateStats } from '../_lib/load-balancer.js';

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
    // Get raw body for Slack signature verification
    const rawBody = await getRawBody(req);
    const body = rawBody.toString();
    
    // Parse JSON for our use
    const jsonBody = JSON.parse(body);
    
    // Select developer using load balancing
    const selectedDeveloper = selectDeveloper('slack_app');
    
    if (!selectedDeveloper) {
      return res.status(503).json({ 
        error: 'No available developers',
        service: 'slack_app'
      });
    }
    
    console.log(`Load balancing Slack event to developer: ${selectedDeveloper}`);
    
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
      ...req,
      body: jsonBody, // For our proxy function
      rawBody: body   // For Slack signature verification
    };
    
    // Proxy the request
    try {
      const result = await proxyRequest(modifiedReq, `${targetUrl}/slack/events`);
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
    console.error('Error in Slack events handler:', error);
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