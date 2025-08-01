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

// Helper function to create proxy middleware with retry logic
function createSlackProxyWithRetry(targetUrl) {
  const https = require('https');
  
  const baseProxy = createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    secure: true,
    // Optimize for Slack's 3-second timeout requirement
    agent: new https.Agent({
      keepAlive: false,        // Disable keep-alive completely
      maxSockets: 10,          // Allow more concurrent connections for speed
      timeout: 2000,           // Very short socket timeout (2 seconds)
      rejectUnauthorized: true, // Verify SSL certificates
      // Force HTTP/1.1 by disabling HTTP/2
      maxVersion: 'TLSv1.3',
      minVersion: 'TLSv1.2'
    }),
    // Fast timeouts to meet Slack's 3-second requirement
    timeout: 2500,           // 2.5 seconds per attempt (leave 0.5s for processing)
    proxyTimeout: 2500,      // 2.5 seconds per attempt
    // Configure connection handling
    followRedirects: false,   // Disable redirects to prevent delays
    ws: false,               // Disable websockets
    xfwd: false,             // Disable X-Forwarded headers that might confuse ngrok
    onProxyReq: (proxyReq, req, res) => {
      console.log(`[PROXY_REQ] Fast attempt ${req.retryAttempt || 1}/2: ${targetUrl}${req.url}`);
      
      // Force HTTP/1.1 explicitly
      proxyReq.setHeader('Connection', 'close');
      proxyReq.setHeader('Cache-Control', 'no-cache');
      
      // Add ngrok bypass header for free accounts
      proxyReq.setHeader('ngrok-skip-browser-warning', 'true');
      
      // Use original User-Agent or set a clear one
      const userAgent = req.get('User-Agent') || 'Flush-Load-Balancer/1.0';
      proxyReq.setHeader('User-Agent', userAgent);
      
      // Remove any problematic headers that might cause HTTP/2 issues
      proxyReq.removeHeader('upgrade');
      proxyReq.removeHeader('http2-settings');
      proxyReq.removeHeader(':method');
      proxyReq.removeHeader(':path');
      proxyReq.removeHeader(':scheme');
      proxyReq.removeHeader(':authority');
      
      // Preserve critical Slack headers
      if (req.get('X-Slack-Signature')) {
        proxyReq.setHeader('X-Slack-Signature', req.get('X-Slack-Signature'));
      }
      if (req.get('X-Slack-Request-Timestamp')) {
        proxyReq.setHeader('X-Slack-Request-Timestamp', req.get('X-Slack-Request-Timestamp'));
      }
      
      // Log timing and debug info
      req.startTime = Date.now();
      console.log(`[PROXY_REQ] Headers: UA="${userAgent}", ngrok-skip="${proxyReq.getHeader('ngrok-skip-browser-warning')}"`);
    },
    onProxyRes: (proxyRes, req, res) => {
      const duration = Date.now() - (req.startTime || Date.now());
      console.log(`[PROXY_SUCCESS] ✅ ${proxyRes.statusCode} in ${duration}ms (attempt ${req.retryAttempt || 1})`);
      
      // Update request count
      if (req.selectedDeveloper) {
        requestCounts[req.selectedDeveloper] = (requestCounts[req.selectedDeveloper] || 0) + 1;
        // Mark as healthy on successful response
        healthStatus[req.selectedDeveloper] = 'healthy';
        // Reset failure counter on success
        const failureKey = `${req.selectedDeveloper}_failures`;
        if (global[failureKey]) {
          console.log(`[HEALTH_CHECK] Reset failure counter for ${req.selectedDeveloper}`);
          global[failureKey] = 0;
        }
      }
    },
    onError: (err, req, res) => {
      const duration = Date.now() - (req.startTime || Date.now());
      const attempt = req.retryAttempt || 1;
      console.error(`[PROXY_ERROR] ❌ Attempt ${attempt}/2 - ${err.code}: ${err.message} (${duration}ms)`);
      
      // Check if this is a retryable error and we have time for a retry
      const isRetryableError = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EPIPE' || err.code === 'ENOTFOUND' || err.code === 'ECONNABORTED';
      const totalTimeElapsed = Date.now() - req.startTime;
      const hasTimeForRetry = totalTimeElapsed < 1500; // Only retry if we have at least 1.5s left
      
      if (isRetryableError && attempt < 2 && hasTimeForRetry && !res.headersSent) {
        console.log(`[RETRY] 🔄 Quick retry (${totalTimeElapsed}ms elapsed, ${3000 - totalTimeElapsed}ms remaining)`);
        req.retryAttempt = attempt + 1;
        
        // Immediate retry - no delay for speed
        setImmediate(() => {
          console.log(`[RETRY] Starting retry attempt ${attempt + 1}`);
          const retryProxy = createSlackProxyWithRetry(targetUrl);
          retryProxy(req, res);
        });
        return;
      }
      
      // Handle permanent failure or no time left
      const reason = !hasTimeForRetry ? 'no time remaining' : 'max retries reached';
      console.error(`[PROXY_ERROR] ❌ Failed after ${attempt} attempts (${reason})`);
      
      // More nuanced health checking
      if (req.selectedDeveloper) {
        if (isRetryableError) {
          const failureKey = `${req.selectedDeveloper}_failures`;
          global[failureKey] = (global[failureKey] || 0) + 1;
          
          console.log(`[HEALTH_CHECK] Connection issue with ${req.selectedDeveloper} (${global[failureKey]}/3 failures): ${err.code}`);
          
          if (global[failureKey] >= 3) {
            healthStatus[req.selectedDeveloper] = 'unhealthy';
            console.log(`[HEALTH_CHECK] Marked ${req.selectedDeveloper} as unhealthy after ${global[failureKey]} connection failures`);
          }
        } else if (err.code === 'ECONNREFUSED') {
          healthStatus[req.selectedDeveloper] = 'unhealthy';
          console.log(`[HEALTH_CHECK] Marked ${req.selectedDeveloper} as unhealthy due to ${err.code}`);
        }
      }

      // Return appropriate error response
      if (!res.headersSent) {
        const isTimeoutError = err.code === 'ETIMEDOUT' || duration > 2000;
        const isConnectionError = err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE' || err.code === 'ECONNABORTED';
        const statusCode = isTimeoutError ? 504 : (isConnectionError ? 502 : 500);
        const errorType = isTimeoutError ? 'Gateway Timeout' : (isConnectionError ? 'Bad Gateway' : 'Internal Server Error');
        
        res.status(statusCode).json({ 
          error: errorType,
          message: `Backend service ${isTimeoutError ? 'timed out' : isConnectionError ? 'connection failed' : 'error'} after ${attempt} attempts`,
          developer: req.selectedDeveloper,
          service: req.service,
          target: targetUrl,
          duration_ms: duration,
          error_code: err.code,
          error_message: err.message,
          attempts: attempt,
          slack_timeout_note: 'Optimized for Slack 3-second requirement'
        });
      }
    }
  });
  
  return baseProxy;
}

// Helper function to create proxy middleware (keeping old name for compatibility)
function createSlackProxy(targetUrl) {
  return createSlackProxyWithRetry(targetUrl);
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