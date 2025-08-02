import { selectDeveloper, getTargetUrl, proxyRequest, updateStats } from '../_lib/load-balancer.js';

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Select developer using load balancing
    const sessionId = req.headers['x-slack-signature'] || req.headers['x-forwarded-for'];
    const selectedDeveloper = selectDeveloper('slack_app', sessionId);
    
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
    
    // Proxy the request
    try {
      const result = await proxyRequest(req, `${targetUrl}/slack/interactions`);
      updateStats(selectedDeveloper, true);
      
      return res.status(result.status).json(result.data);
    } catch (proxyError) {
      updateStats(selectedDeveloper, false);
      
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