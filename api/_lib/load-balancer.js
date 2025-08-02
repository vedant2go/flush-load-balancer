// Shared load balancer utilities for Vercel functions

// Load balancer state (in-memory for this instance)
let roundRobinIndex = 0;
const requestCounts = {};
const healthStatus = {};

// Load developers from environment variables
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
    developers.vedant = {
      slack_app: process.env.DEFAULT_NGROK_URL || 'https://67ccbee1763c.ngrok-free.app'
    };
  }
  
  return developers;
}

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
}

// Select developer using load balancer
function selectDeveloper(service, sessionId = null) {
  const developers = loadDevelopersFromEnv();
  const strategy = process.env.LOAD_BALANCER_STRATEGY || 'round_robin';
  
  let selectedDeveloper = null;
  
  switch (strategy) {
    case 'round_robin':
      selectedDeveloper = LoadBalancer.roundRobin(developers, service);
      break;
    case 'least_connections':
      selectedDeveloper = LoadBalancer.leastConnections(developers, service);
      break;
    case 'random':
      selectedDeveloper = LoadBalancer.random(developers, service);
      break;
    default:
      selectedDeveloper = LoadBalancer.roundRobin(developers, service);
  }
  
  return selectedDeveloper;
}

// Get target URL for developer and service
function getTargetUrl(developer, service) {
  const developers = loadDevelopersFromEnv();
  const developerConfig = developers[developer];
  if (!developerConfig) {
    return null;
  }
  
  return developerConfig[service] || null;
}

// Proxy request to target URL
async function proxyRequest(req, targetUrl) {
  const startTime = Date.now();
  
  try {
    console.log(`[PROXY] → ${targetUrl} (body: ${req.body ? JSON.stringify(req.body).length : 0} bytes)`);
    
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
        'Connection': 'close',
        'User-Agent': req.headers['user-agent'] || 'Vercel-Load-Balancer/1.0',
        // Preserve Slack headers
        ...(req.headers['x-slack-signature'] && { 'X-Slack-Signature': req.headers['x-slack-signature'] }),
        ...(req.headers['x-slack-request-timestamp'] && { 'X-Slack-Request-Timestamp': req.headers['x-slack-request-timestamp'] })
      },
      body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
      // Slack 3-second timeout requirement
      signal: AbortSignal.timeout(2800)
    });
    
    const duration = Date.now() - startTime;
    console.log(`[PROXY] ✅ ${response.status} in ${duration}ms`);
    
    const responseData = await response.json();
    return {
      status: response.status,
      data: responseData,
      duration
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[PROXY] ❌ ${error.message} (${duration}ms)`);
    
    throw {
      status: error.name === 'TimeoutError' ? 504 : 502,
      error: error.name === 'TimeoutError' ? 'Gateway Timeout' : 'Bad Gateway',
      message: error.message,
      duration
    };
  }
}

// Update request stats
function updateStats(developer, success = true) {
  if (developer) {
    requestCounts[developer] = (requestCounts[developer] || 0) + 1;
    healthStatus[developer] = success ? 'healthy' : 'unhealthy';
  }
}

export {
  selectDeveloper,
  getTargetUrl,
  proxyRequest,
  updateStats,
  loadDevelopersFromEnv,
  requestCounts,
  healthStatus
}; 