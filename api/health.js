const { loadDevelopersFromEnv, requestCounts, healthStatus } = require('./_lib/load-balancer');

export default async function handler(req, res) {
  try {
    const developers = loadDevelopersFromEnv();
    const developerList = Object.keys(developers);
    const serviceList = ['slack_app', 'slack_oauth', 'google_sheets'];
    
    return res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      platform: 'vercel',
      developers: developerList,
      load_balancer_strategy: process.env.LOAD_BALANCER_STRATEGY || 'round_robin',
      environment: process.env.NODE_ENV || 'production',
      services: serviceList,
      request_counts: requestCounts,
      health_status: healthStatus,
      services_handled: {
        slack_app: '/slack/events',
        slack_interactions: '/slack/interactions',
        slack_oauth: '/slack/oauth/*',
        google_sheets_oauth: '/google-sheets/oauth/*'
      }
    });
  } catch (error) {
    console.error('Error in health check:', error);
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
} 