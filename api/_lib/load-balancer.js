// Simple load balancer for Vercel functions

// In-memory state (resets on cold starts)
let roundRobinIndex = 0;
const requestCounts = {};

// Load developers from environment variables
function loadDevelopers() {
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
  return developers;
}

// Load balancer strategies
function roundRobin(developers, service) {
  const availableDevelopers = Object.keys(developers).filter(dev => 
    developers[dev][service]
  );
  
  if (availableDevelopers.length === 0) return null;
  
  const developer = availableDevelopers[roundRobinIndex % availableDevelopers.length];
  roundRobinIndex = (roundRobinIndex + 1) % availableDevelopers.length;
  return developer;
}

function leastConnections(developers, service) {
  const availableDevelopers = Object.keys(developers).filter(dev => 
    developers[dev][service]
  );
  
  if (availableDevelopers.length === 0) return null;
  
  return availableDevelopers.reduce((min, dev) => 
    (requestCounts[dev] || 0) < (requestCounts[min] || 0) ? dev : min
  );
}

function random(developers, service) {
  const availableDevelopers = Object.keys(developers).filter(dev => 
    developers[dev][service]
  );
  
  if (availableDevelopers.length === 0) return null;
  
  const randomIndex = Math.floor(Math.random() * availableDevelopers.length);
  return availableDevelopers[randomIndex];
}

// Select developer using load balancer
function selectDeveloper(service) {
  const developers = loadDevelopers();
  const strategy = process.env.LOAD_BALANCER_STRATEGY || 'round_robin';
  
  let selectedDeveloper = null;
  
  switch (strategy) {
    case 'round_robin':
      selectedDeveloper = roundRobin(developers, service);
      break;
    case 'least_connections':
      selectedDeveloper = leastConnections(developers, service);
      break;
    case 'random':
      selectedDeveloper = random(developers, service);
      break;
    default:
      selectedDeveloper = roundRobin(developers, service);
  }
  
  return selectedDeveloper;
}

// Get target URL for developer and service
function getTargetUrl(developer, service) {
  const developers = loadDevelopers();
  const developerConfig = developers[developer];
  if (!developerConfig) return null;
  
  return developerConfig[service] || null;
}

// Update request stats
function updateStats(developer) {
  if (developer) {
    requestCounts[developer] = (requestCounts[developer] || 0) + 1;
  }
}

// Proxy request to target
async function proxyRequest(req, targetUrl) {
  const startTime = Date.now();
  
  try {
    console.log(`[PROXY] → ${targetUrl}`);
    
    // Build headers object, preserving all Slack headers
    const headers = {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
      'Connection': 'close',
      'User-Agent': req.headers['user-agent'] || 'Vercel-Load-Balancer/1.0'
    };
    
    // Forward all Slack-related headers
    const slackHeaders = [
      'x-slack-signature',
      'x-slack-request-timestamp',
      'x-slack-retry-num',
      'x-slack-retry-reason'
    ];
    
    slackHeaders.forEach(header => {
      if (req.headers[header]) {
        headers[header] = req.headers[header];
      }
    });
    
    console.log(`[PROXY] Headers: ${JSON.stringify(headers)}`);
    
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(2800) // Slack 3-second timeout
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

export {
  selectDeveloper,
  getTargetUrl,
  proxyRequest,
  updateStats,
  loadDevelopers,
  requestCounts
}; 