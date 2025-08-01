const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 6000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Load balancer strategies
const LOAD_BALANCER_STRATEGY = process.env.LOAD_BALANCER_STRATEGY || 'round_robin';

// Load developers from environment variables with service-specific URLs
function loadDevelopersFromEnv() {
  const developers = {};
  
  // Parse developer mappings from environment variables
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DEVELOPER_')) {
      const parts = key.replace('DEVELOPER_', '').split('_');
      if (parts.length >= 2) {
        const developerName = parts[0].toLowerCase();
        const service = parts.slice(1).join('_').toLowerCase();
        
        if (!developers[developerName]) {
          developers[developerName] = {};
        }
        developers[developerName][service] = value;
      }
    }
  }
  
  // Fallback to hardcoded developers if no env vars are set
  if (Object.keys(developers).length === 0) {
    console.log('⚠️  No developer environment variables found, using default mappings');
    developers.alice = {
      slack_app: 'https://alice-slack-app.ngrok-free.app',
      slack_oauth: 'https://alice-slack-oauth.ngrok-free.app',
      google_sheets: 'https://alice-google-sheets.ngrok-free.app'
    };
    developers.bob = {
      slack_app: 'https://bob-slack-app.ngrok-free.app',
      slack_oauth: 'https://bob-slack-oauth.ngrok-free.app',
      google_sheets: 'https://bob-google-sheets.ngrok-free.app'
    };
    developers.charlie = {
      slack_app: 'https://charlie-slack-app.ngrok-free.app',
      slack_oauth: 'https://charlie-slack-oauth.ngrok-free.app',
      google_sheets: 'https://charlie-google-sheets.ngrok-free.app'
    };
  }
  
  return developers;
}

// Load developers
const developers = loadDevelopersFromEnv();

// Load balancer state
let roundRobinIndex = 0;
const requestCounts = {};
const healthStatus = {};

// Load balancer strategies
class LoadBalancer {
  static roundRobin(developers, service) {
    const availableDevelopers = Object.keys(developers).filter(dev => 
      developers[dev][service] && healthStatus[dev] !== 'unhealthy'
    );
    
    if (availableDevelopers.length === 0) {
      return null;
    }
    
    const developer = availableDevelopers[roundRobinIndex % availableDevelopers.length];
    roundRobinIndex = (roundRobinIndex + 1) % availableDevelopers.length;
    return developer;
  }
  
  static leastConnections(developers, service) {
    const availableDevelopers = Object.keys(developers).filter(dev => 
      developers[dev][service] && healthStatus[dev] !== 'unhealthy'
    );
    
    if (availableDevelopers.length === 0) {
      return null;
    }
    
    return availableDevelopers.reduce((min, dev) => 
      (requestCounts[dev] || 0) < (requestCounts[min] || 0) ? dev : min
    );
  }
  
  static random(developers, service) {
    const availableDevelopers = Object.keys(developers).filter(dev => 
      developers[dev][service] && healthStatus[dev] !== 'unhealthy'
    );
    
    if (availableDevelopers.length === 0) {
      return null;
    }
    
    const randomIndex = Math.floor(Math.random() * availableDevelopers.length);
    return availableDevelopers[randomIndex];
  }
  
  static weighted(developers, service) {
    const availableDevelopers = Object.keys(developers).filter(dev => 
      developers[dev][service] && healthStatus[dev] !== 'unhealthy'
    );
    
    if (availableDevelopers.length === 0) {
      return null;
    }
    
    // Simple weighted round-robin (can be enhanced with actual weights)
    const weights = {
      'alice': 3,   // 30% of traffic
      'bob': 3,     // 30% of traffic
      'charlie': 4  // 40% of traffic
    };
    
    const totalWeight = availableDevelopers.reduce((sum, dev) => sum + (weights[dev] || 1), 0);
    let random = Math.random() * totalWeight;
    
    for (const dev of availableDevelopers) {
      random -= (weights[dev] || 1);
      if (random <= 0) {
        return dev;
      }
    }
    
    return availableDevelopers[0];
  }
  
  static sticky(developers, service, sessionId) {
    const availableDevelopers = Object.keys(developers).filter(dev => 
      developers[dev][service] && healthStatus[dev] !== 'unhealthy'
    );
    
    if (availableDevelopers.length === 0) {
      return null;
    }
    
    // Use session ID to consistently route to same developer
    if (sessionId) {
      const hash = sessionId.split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0);
        return a & a;
      }, 0);
      const index = Math.abs(hash) % availableDevelopers.length;
      return availableDevelopers[index];
    }
    
    // Fallback to round-robin if no session ID
    return this.roundRobin(developers, service);
  }
}

// Helper function to get target URL for developer and service
function getTargetUrl(developer, service) {
  const developerConfig = developers[developer];
  if (!developerConfig) {
    return null;
  }
  
  return developerConfig[service] || null;
}

// Helper function to create proxy middleware
function createSlackProxy(targetUrl) {
  return createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    secure: true,
    timeout: 30000,
    proxyTimeout: 30000,
    onProxyReq: (proxyReq, req, res) => {
      console.log(`Load balancing to: ${targetUrl}${req.url}`);
      // Add ngrok bypass header for free accounts
      proxyReq.setHeader('ngrok-skip-browser-warning', 'true');
    },
    onProxyRes: (proxyRes, req, res) => {
      console.log(`Response from ${targetUrl}: ${proxyRes.statusCode}`);
      // Update request count
      if (req.selectedDeveloper) {
        requestCounts[req.selectedDeveloper] = (requestCounts[req.selectedDeveloper] || 0) + 1;
      }
    },
    onError: (err, req, res) => {
      console.error(`Proxy error for ${targetUrl}:`, err.message);
      // Mark developer as unhealthy
      if (req.selectedDeveloper) {
        healthStatus[req.selectedDeveloper] = 'unhealthy';
        console.log(`Marked ${req.selectedDeveloper} as unhealthy`);
      }
      res.status(502).json({ 
        error: 'Backend service unavailable',
        developer: req.selectedDeveloper,
        service: req.service,
        target: targetUrl
      });
    }
  });
}

// Helper function to select developer using load balancer
function selectDeveloper(service, sessionId = null) {
  let selectedDeveloper = null;
  
  switch (LOAD_BALANCER_STRATEGY) {
    case 'round_robin':
      selectedDeveloper = LoadBalancer.roundRobin(developers, service);
      break;
    case 'least_connections':
      selectedDeveloper = LoadBalancer.leastConnections(developers, service);
      break;
    case 'random':
      selectedDeveloper = LoadBalancer.random(developers, service);
      break;
    case 'weighted':
      selectedDeveloper = LoadBalancer.weighted(developers, service);
      break;
    case 'sticky':
      selectedDeveloper = LoadBalancer.sticky(developers, service, sessionId);
      break;
    default:
      selectedDeveloper = LoadBalancer.roundRobin(developers, service);
  }
  
  return selectedDeveloper;
}

// Health check endpoint
app.get('/health', (req, res) => {
  const developerList = Object.keys(developers);
  const serviceList = ['slack_app', 'slack_oauth', 'google_sheets'];
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    developers: developerList,
    load_balancer_strategy: LOAD_BALANCER_STRATEGY,
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
});

// Load balancer info endpoint
app.get('/load-balancer', (req, res) => {
  res.json({
    strategy: LOAD_BALANCER_STRATEGY,
    available_strategies: ['round_robin', 'least_connections', 'random', 'weighted', 'sticky'],
    request_counts: requestCounts,
    health_status: healthStatus,
    developers: Object.keys(developers)
  });
});

// Reset health status endpoint
app.post('/reset-health', (req, res) => {
  Object.keys(healthStatus).forEach(dev => {
    healthStatus[dev] = 'healthy';
  });
  res.json({ message: 'Health status reset', health_status: healthStatus });
});

// Slack events endpoint with load balancing
app.use('/slack/events', (req, res, next) => {
  const sessionId = req.headers['x-slack-signature'] || req.headers['x-forwarded-for'];
  const selectedDeveloper = selectDeveloper('slack_app', sessionId);
  
  if (!selectedDeveloper) {
    return res.status(503).json({ 
      error: 'No available developers',
      service: 'slack_app'
    });
  }
  
  req.selectedDeveloper = selectedDeveloper;
  req.service = 'slack_app';
  
  console.log(`Load balancing Slack event to developer: ${selectedDeveloper}`);
  
  const targetUrl = getTargetUrl(selectedDeveloper, 'slack_app');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: selectedDeveloper,
      service: 'slack_app'
    });
  }
  
  const proxy = createSlackProxy(targetUrl);
  proxy(req, res, next);
});

// Slack interactions endpoint with load balancing
app.use('/slack/interactions', (req, res, next) => {
  const sessionId = req.headers['x-slack-signature'] || req.headers['x-forwarded-for'];
  const selectedDeveloper = selectDeveloper('slack_app', sessionId);
  
  if (!selectedDeveloper) {
    return res.status(503).json({ 
      error: 'No available developers',
      service: 'slack_app'
    });
  }
  
  req.selectedDeveloper = selectedDeveloper;
  req.service = 'slack_app';
  
  console.log(`Load balancing Slack interaction to developer: ${selectedDeveloper}`);
  
  const targetUrl = getTargetUrl(selectedDeveloper, 'slack_app');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: selectedDeveloper,
      service: 'slack_app'
    });
  }
  
  const proxy = createSlackProxy(targetUrl);
  proxy(req, res, next);
});

// Slack OAuth endpoints with load balancing
app.use('/slack/oauth', (req, res, next) => {
  const sessionId = req.headers['x-forwarded-for'] || req.ip;
  const selectedDeveloper = selectDeveloper('slack_oauth', sessionId);
  
  if (!selectedDeveloper) {
    return res.status(503).json({ 
      error: 'No available developers',
      service: 'slack_oauth'
    });
  }
  
  req.selectedDeveloper = selectedDeveloper;
  req.service = 'slack_oauth';
  
  console.log(`Load balancing Slack OAuth to developer: ${selectedDeveloper}`);
  
  const targetUrl = getTargetUrl(selectedDeveloper, 'slack_oauth');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: selectedDeveloper,
      service: 'slack_oauth'
    });
  }
  
  const proxy = createSlackProxy(targetUrl);
  proxy(req, res, next);
});

// Google Sheets OAuth endpoints with load balancing
app.use('/google-sheets/oauth', (req, res, next) => {
  const sessionId = req.headers['x-forwarded-for'] || req.ip;
  const selectedDeveloper = selectDeveloper('google_sheets', sessionId);
  
  if (!selectedDeveloper) {
    return res.status(503).json({ 
      error: 'No available developers',
      service: 'google_sheets'
    });
  }
  
  req.selectedDeveloper = selectedDeveloper;
  req.service = 'google_sheets';
  
  console.log(`Load balancing Google Sheets OAuth to developer: ${selectedDeveloper}`);
  
  const targetUrl = getTargetUrl(selectedDeveloper, 'google_sheets');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: selectedDeveloper,
      service: 'google_sheets'
    });
  }
  
  const proxy = createSlackProxy(targetUrl);
  proxy(req, res, next);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    available_endpoints: [
      '/health',
      '/load-balancer',
      '/reset-health',
      '/slack/events',
      '/slack/interactions',
      '/slack/oauth/*',
      '/google-sheets/oauth/*'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Flush Load Balancer running on port ${PORT}`);
  console.log(`📋 Available developers: ${Object.keys(developers).join(', ')}`);
  console.log(`⚖️  Load balancer strategy: ${LOAD_BALANCER_STRATEGY}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`⚖️  Load balancer info: http://localhost:${PORT}/load-balancer`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`\n📝 Service URLs for Slack App configuration:`);
  console.log(`   Events: http://localhost:${PORT}/slack/events`);
  console.log(`   Interactions: http://localhost:${PORT}/slack/interactions`);
  console.log(`   OAuth: http://localhost:${PORT}/slack/oauth/callback`);
  console.log(`   Google Sheets OAuth: http://localhost:${PORT}/google-sheets/oauth/callback`);
}); 