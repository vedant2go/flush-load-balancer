// Simple load balancer for Vercel functions

// In-memory state (resets on cold starts)
let roundRobinIndex = 0;
const requestCounts = {};
const processedRequests = new Set(); // Track processed requests for idempotency

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

// Check if request is a duplicate (idempotency)
function isDuplicateRequest(req) {
  const slackSignature = req.headers['x-slack-signature'];
  const slackTimestamp = req.headers['x-slack-request-timestamp'];
  const retryNum = req.headers['x-slack-retry-num'] || '0';
  
  // Create a unique request ID
  const requestId = `${slackSignature}-${slackTimestamp}-${retryNum}`;
  
  if (processedRequests.has(requestId)) {
    console.log(`[PROXY] ⚠️  Duplicate request detected: ${requestId}`);
    return true;
  }
  
  // Add to processed set
  processedRequests.add(requestId);
  
  // Clean up old entries (keep last 1000 requests)
  if (processedRequests.size > 1000) {
    const entries = Array.from(processedRequests);
    processedRequests.clear();
    entries.slice(-500).forEach(id => processedRequests.add(id));
  }
  
  return false;
}

// Proxy request to target
async function proxyRequest(req, targetUrl) {
  const startTime = Date.now();
  
  try {
    console.log(`[PROXY] → ${targetUrl}`);
    console.log(`[PROXY] Available headers:`, Object.keys(req.headers));
    
    // Build headers object, preserving all Slack headers
    const headers = {
      'ngrok-skip-browser-warning': 'true',
      'Connection': 'close'
    };
    
    // Set User-Agent more safely
    const userAgent = req.headers['user-agent'] || 
                     req.headers['User-Agent'] || 
                     req.headers['User-agent'] ||
                     'Vercel-Load-Balancer/1.0';
    headers['User-Agent'] = userAgent;
    
    // Set appropriate Content-Type based on body format
    if (req.rawBody && req.rawBody.includes('payload=')) {
      // URL-encoded form data
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      // JSON data
      headers['Content-Type'] = 'application/json';
    }
    
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
    
    // Preserve the raw body for Slack signature verification
    let body;
    if (req.method === 'POST') {
      // Use raw body if available (for Slack signature verification)
      if (req.rawBody) {
        body = req.rawBody;
        console.log(`[PROXY] Using raw body for Slack signature verification`);
      } else if (typeof req.body === 'string') {
        body = req.body;
      } else {
        // For form data, reconstruct the original format
        if (req.body && typeof req.body === 'object' && req.body.payload) {
          // Reconstruct URL-encoded form data
          body = `payload=${encodeURIComponent(JSON.stringify(req.body.payload))}`;
          console.log(`[PROXY] Reconstructed form data for Slack signature verification`);
        } else {
          // Otherwise, stringify it (but this might break signatures)
          body = JSON.stringify(req.body);
          console.log(`[PROXY] ⚠️  Warning: Body was re-serialized, may break Slack signatures`);
        }
      }
    }
    
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(2800) // Slack 3-second timeout
    });
    
    const duration = Date.now() - startTime;
    console.log(`[PROXY] ✅ ${response.status} in ${duration}ms`);
    
    let responseData;
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      try {
        responseData = await response.json();
      } catch (jsonError) {
        console.log(`[PROXY] JSON parse error: ${jsonError.message}`);
        responseData = { error: 'Invalid JSON response' };
      }
    } else {
      // Handle plain text responses (like "OK")
      const textResponse = await response.text();
      console.log(`[PROXY] Plain text response: ${textResponse}`);
      responseData = { message: textResponse, status: response.status };
    }
    
    return {
      status: response.status,
      data: responseData,
      duration
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[PROXY] ❌ ${error.message} (${duration}ms)`);
    console.error(`[PROXY] Error stack:`, error.stack);
    console.error(`[PROXY] Request headers:`, req.headers);
    
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
  requestCounts,
  isDuplicateRequest
}; 