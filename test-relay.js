#!/usr/bin/env node

/**
 * Test script for the Flush Relay Server
 * Run this to verify your relay server is working correctly
 */

const https = require('https');
const http = require('http');

// Configuration
const RELAY_URL = process.env.RELAY_URL || 'https://your-relay-server.railway.app';
const DEVELOPERS = ['alice', 'bob', 'charlie'];

console.log('🧪 Testing Flush Relay Server...\n');

// Helper function to make HTTP requests
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = client.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          resolve({ status: res.statusCode, data: jsonData });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

// Test functions
async function testHealthCheck() {
  console.log('1️⃣ Testing health check...');
  try {
    const response = await makeRequest(`${RELAY_URL}/health`);
    if (response.status === 200) {
      console.log('✅ Health check passed');
      console.log(`   Status: ${response.data.status}`);
      console.log(`   Developers: ${response.data.developers.join(', ')}`);
      console.log(`   Default: ${response.data.default_developer}\n`);
      return true;
    } else {
      console.log('❌ Health check failed');
      console.log(`   Status: ${response.status}`);
      console.log(`   Response: ${JSON.stringify(response.data)}\n`);
      return false;
    }
  } catch (error) {
    console.log('❌ Health check error:', error.message, '\n');
    return false;
  }
}

async function testDevelopersEndpoint() {
  console.log('2️⃣ Testing developers endpoint...');
  try {
    const response = await makeRequest(`${RELAY_URL}/developers`);
    if (response.status === 200) {
      console.log('✅ Developers endpoint passed');
      console.log(`   Available developers: ${Object.keys(response.data.developers).join(', ')}\n`);
      return true;
    } else {
      console.log('❌ Developers endpoint failed');
      console.log(`   Status: ${response.status}\n`);
      return false;
    }
  } catch (error) {
    console.log('❌ Developers endpoint error:', error.message, '\n');
    return false;
  }
}

async function testSlackEventsRouting() {
  console.log('3️⃣ Testing Slack events routing...');
  
  for (const developer of DEVELOPERS) {
    try {
      const response = await makeRequest(`${RELAY_URL}/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Developer-ID': developer
        },
        body: JSON.stringify({
          type: 'url_verification',
          challenge: 'test-challenge'
        })
      });
      
      console.log(`   ${developer}: ${response.status === 200 ? '✅' : '❌'} (${response.status})`);
    } catch (error) {
      console.log(`   ${developer}: ❌ Error - ${error.message}`);
    }
  }
  console.log('');
}

async function testSlackInteractionsRouting() {
  console.log('4️⃣ Testing Slack interactions routing...');
  
  for (const developer of DEVELOPERS) {
    try {
      const response = await makeRequest(`${RELAY_URL}/slack/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Developer-ID': developer
        },
        body: JSON.stringify({
          type: 'block_actions',
          user: { id: 'test-user' }
        })
      });
      
      console.log(`   ${developer}: ${response.status === 200 ? '✅' : '❌'} (${response.status})`);
    } catch (error) {
      console.log(`   ${developer}: ❌ Error - ${error.message}`);
    }
  }
  console.log('');
}

async function testQueryParameterRouting() {
  console.log('5️⃣ Testing query parameter routing...');
  
  for (const developer of DEVELOPERS) {
    try {
      const response = await makeRequest(`${RELAY_URL}/slack/events?dev=${developer}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'url_verification',
          challenge: 'test-challenge'
        })
      });
      
      console.log(`   ${developer}: ${response.status === 200 ? '✅' : '❌'} (${response.status})`);
    } catch (error) {
      console.log(`   ${developer}: ❌ Error - ${error.message}`);
    }
  }
  console.log('');
}

async function testInvalidDeveloper() {
  console.log('6️⃣ Testing invalid developer handling...');
  try {
    const response = await makeRequest(`${RELAY_URL}/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Developer-ID': 'invalid-developer'
      },
      body: JSON.stringify({
        type: 'url_verification',
        challenge: 'test-challenge'
      })
    });
    
    console.log(`   Invalid developer: ${response.status === 200 ? '✅' : '❌'} (${response.status})`);
    console.log('   (Should fallback to default developer)\n');
  } catch (error) {
    console.log(`   Invalid developer: ❌ Error - ${error.message}\n`);
  }
}

// Main test function
async function runTests() {
  console.log(`🔗 Testing relay server: ${RELAY_URL}\n`);
  
  const tests = [
    testHealthCheck,
    testDevelopersEndpoint,
    testSlackEventsRouting,
    testSlackInteractionsRouting,
    testQueryParameterRouting,
    testInvalidDeveloper
  ];
  
  let passedTests = 0;
  
  for (const test of tests) {
    const result = await test();
    if (result !== false) {
      passedTests++;
    }
  }
  
  console.log('📊 Test Summary');
  console.log(`   Tests passed: ${passedTests}/${tests.length}`);
  
  if (passedTests === tests.length) {
    console.log('🎉 All tests passed! Your relay server is working correctly.');
  } else {
    console.log('⚠️  Some tests failed. Check your relay server configuration.');
  }
  
  console.log('\n📝 Next steps:');
  console.log('   1. Update your Slack app event URL to use the relay server');
  console.log('   2. Test with real Slack events');
  console.log('   3. Update developer mappings in server.js as needed');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = {
  testHealthCheck,
  testDevelopersEndpoint,
  testSlackEventsRouting,
  testSlackInteractionsRouting,
  testQueryParameterRouting,
  testInvalidDeveloper,
  runTests
}; 