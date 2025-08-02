import { loadDevelopersFromEnv, requestCounts, healthStatus } from './_lib/load-balancer.js';

export default async function handler(req, res) {
  try {
    const developers = loadDevelopersFromEnv();
    
    return res.status(200).json({
      strategy: process.env.LOAD_BALANCER_STRATEGY || 'round_robin',
      available_strategies: ['round_robin', 'least_connections', 'random'],
      request_counts: requestCounts,
      health_status: healthStatus,
      developers: Object.keys(developers),
      platform: 'vercel',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in load balancer info:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
} 