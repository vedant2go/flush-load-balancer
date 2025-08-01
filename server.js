const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Load developers from environment variables with service-specific URLs
function loadDevelopersFromEnv() {
  const developers = {};
  
  // Parse developer mappings from environment variables
  // Format: DEVELOPER_[NAME]_[SERVICE]=https://[name]-[service].ngrok-free.app
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

// Default developer if none specified
const DEFAULT_DEVELOPER = process.env.DEFAULT_DEVELOPER || 'alice';

// Helper function to get target URL for developer and service
function getTargetUrl(developer, service) {
  const developerConfig = developers[developer];
  if (!developerConfig) {
    console.warn(`Developer '${developer}' not found, using default: ${DEFAULT_DEVELOPER}`);
    const defaultConfig = developers[DEFAULT_DEVELOPER];
    return defaultConfig ? defaultConfig[service] : null;
  }
  
  const target = developerConfig[service];
  if (!target) {
    console.warn(`Service '${service}' not found for developer '${developer}', using default`);
    const defaultConfig = developers[DEFAULT_DEVELOPER];
    return defaultConfig ? defaultConfig[service] : null;
  }
  
  return target;
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
      console.log(`Proxying to: ${targetUrl}${req.url}`);
    },
    onProxyRes: (proxyRes, req, res) => {
      console.log(`Response from ${targetUrl}: ${proxyRes.statusCode}`);
    },
    onError: (err, req, res) => {
      console.error(`Proxy error for ${targetUrl}:`, err.message);
      res.status(502).json({ 
        error: 'Backend service unavailable',
        developer: req.developer,
        service: req.service,
        target: targetUrl
      });
    }
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  const developerList = Object.keys(developers);
  const serviceList = ['slack_app', 'slack_oauth', 'google_sheets'];
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    developers: developerList,
    default_developer: DEFAULT_DEVELOPER,
    environment: process.env.NODE_ENV || 'production',
    services: serviceList,
    services_handled: {
      slack_app: '/slack/events',
      slack_interactions: '/slack/interactions',
      slack_oauth: '/slack/oauth/*',
      google_sheets_oauth: '/google-sheets/oauth/*'
    }
  });
});

// Developer info endpoint
app.get('/developers', (req, res) => {
  res.json({
    developers: developers,
    default: DEFAULT_DEVELOPER,
    environment: process.env.NODE_ENV || 'production'
  });
});

// Service-specific endpoints
app.get('/services', (req, res) => {
  res.json({
    services: {
      slack_app: {
        description: 'Slack app events and interactions',
        endpoints: ['/slack/events', '/slack/interactions'],
        example_url: `${req.protocol}://${req.get('host')}/slack/events`
      },
      slack_oauth: {
        description: 'Slack OAuth flow',
        endpoints: ['/slack/oauth/*'],
        example_url: `${req.protocol}://${req.get('host')}/slack/oauth/callback`
      },
      google_sheets_oauth: {
        description: 'Google Sheets OAuth flow',
        endpoints: ['/google-sheets/oauth/*'],
        example_url: `${req.protocol}://${req.get('host')}/google-sheets/oauth/callback`
      }
    }
  });
});

// Slack events endpoint (Service 1: Slack App)
app.use('/slack/events', (req, res, next) => {
  // Extract developer from header or query parameter
  const developer = req.headers['x-developer-id'] || 
                   req.query.dev || 
                   req.headers['x-slack-developer'] || 
                   DEFAULT_DEVELOPER;
  
  // Store developer and service info for logging
  req.developer = developer;
  req.service = 'slack_app';
  
  console.log(`Slack event request for developer: ${developer}`);
  
  const targetUrl = getTargetUrl(developer, 'slack_app');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: developer,
      service: 'slack_app'
    });
  }
  
  const proxy = createSlackProxy(targetUrl);
  proxy(req, res, next);
});

// Slack interactions endpoint (Service 1: Slack App)
app.use('/slack/interactions', (req, res, next) => {
  const developer = req.headers['x-developer-id'] || 
                   req.query.dev || 
                   req.headers['x-slack-developer'] || 
                   DEFAULT_DEVELOPER;
  
  req.developer = developer;
  req.service = 'slack_app';
  
  console.log(`Slack interaction request for developer: ${developer}`);
  
  const targetUrl = getTargetUrl(developer, 'slack_app');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: developer,
      service: 'slack_app'
    });
  }
  
  const proxy = createSlackProxy(targetUrl);
  proxy(req, res, next);
});

// Slack OAuth endpoints (Service 2: Slack OAuth)
app.use('/slack/oauth', (req, res, next) => {
  const developer = req.headers['x-developer-id'] || 
                   req.query.dev || 
                   DEFAULT_DEVELOPER;
  
  req.developer = developer;
  req.service = 'slack_oauth';
  
  console.log(`Slack OAuth request for developer: ${developer}`);
  
  const targetUrl = getTargetUrl(developer, 'slack_oauth');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: developer,
      service: 'slack_oauth'
    });
  }
  
  const proxy = createSlackProxy(targetUrl);
  proxy(req, res, next);
});

// Google Sheets OAuth endpoints (Service 3: Google Sheets OAuth)
app.use('/google-sheets/oauth', (req, res, next) => {
  const developer = req.headers['x-developer-id'] || 
                   req.query.dev || 
                   DEFAULT_DEVELOPER;
  
  req.developer = developer;
  req.service = 'google_sheets';
  
  console.log(`Google Sheets OAuth request for developer: ${developer}`);
  
  const targetUrl = getTargetUrl(developer, 'google_sheets');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: developer,
      service: 'google_sheets'
    });
  }
  
  const proxy = createSlackProxy(targetUrl);
  proxy(req, res, next);
});

// Catch-all for other Slack endpoints
app.use('/slack', (req, res, next) => {
  const developer = req.headers['x-developer-id'] || 
                   req.query.dev || 
                   DEFAULT_DEVELOPER;
  
  req.developer = developer;
  req.service = 'slack_app'; // Default to slack_app for other slack endpoints
  
  console.log(`Slack request for developer: ${developer}`);
  
  const targetUrl = getTargetUrl(developer, 'slack_app');
  if (!targetUrl) {
    return res.status(502).json({ 
      error: 'No target URL found for developer and service',
      developer: developer,
      service: 'slack_app'
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
      '/developers',
      '/services',
      '/slack/events',
      '/slack/interactions',
      '/slack/oauth/*',
      '/google-sheets/oauth/*'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Flush Relay Server running on port ${PORT}`);
  console.log(`📋 Available developers: ${Object.keys(developers).join(', ')}`);
  console.log(`🎯 Default developer: ${DEFAULT_DEVELOPER}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Developer info: http://localhost:${PORT}/developers`);
  console.log(`🔧 Services info: http://localhost:${PORT}/services`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`\n📝 Service URLs for Slack App configuration:`);
  console.log(`   Events: http://localhost:${PORT}/slack/events`);
  console.log(`   Interactions: http://localhost:${PORT}/slack/interactions`);
  console.log(`   OAuth: http://localhost:${PORT}/slack/oauth/callback`);
  console.log(`   Google Sheets OAuth: http://localhost:${PORT}/google-sheets/oauth/callback`);
}); 