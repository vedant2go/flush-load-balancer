# Flush Load Balancer - Vercel Edition

A **fast, serverless load balancer** for Slack webhooks deployed on Vercel's edge network.

## 🚀 Why Vercel?

- **Sub-100ms response times** (vs Render's slower infrastructure)
- **Edge network** with global distribution
- **Built for serverless** - perfect for simple proxying
- **Better ngrok compatibility** - serverless functions work well with tunneling services
- **Meets Slack's 3-second timeout** easily

## 📁 Structure

```
api/
├── _lib/
│   └── load-balancer.js     # Shared utilities
├── slack/
│   ├── events.js            # Slack events endpoint
│   └── interactions.js      # Slack interactions endpoint
├── health.js                # Health check
└── load-balancer.js         # Load balancer info
```

## 🔧 Environment Variables

Set these in your Vercel dashboard:

### Developer Mappings
```bash
# Your developers (replace with actual ngrok URLs)
DEVELOPER_VEDANT_SLACK_APP=https://67ccbee1763c.ngrok-free.app
DEVELOPER_ALICE_SLACK_APP=https://alice-slack-app.ngrok-free.app
DEVELOPER_BOB_SLACK_APP=https://bob-slack-app.ngrok-free.app

# Fallback URL (if no env vars are set)
DEFAULT_NGROK_URL=https://67ccbee1763c.ngrok-free.app

# Load balancer strategy
LOAD_BALANCER_STRATEGY=round_robin
```

### OAuth URLs (optional)
```bash
DEVELOPER_VEDANT_SLACK_OAUTH=https://vedant-oauth.ngrok-free.app
DEVELOPER_VEDANT_GOOGLE_SHEETS=https://vedant-sheets.ngrok-free.app
```

## 🚀 Deployment

### 1. Install Vercel CLI
```bash
npm install -g vercel
```

### 2. Deploy
```bash
cd flush-load-balancer
vercel --prod
```

### 3. Configure Slack
Use your Vercel domain in Slack app settings:
- **Events URL**: `https://your-domain.vercel.app/slack/events`
- **Interactions URL**: `https://your-domain.vercel.app/slack/interactions`

## 📊 Endpoints

- **Health**: `GET /health`
- **Load Balancer Info**: `GET /load-balancer`
- **Slack Events**: `POST /slack/events`
- **Slack Interactions**: `POST /slack/interactions`

## 🔄 Load Balancing Strategies

- `round_robin` (default): Cycles through developers
- `least_connections`: Routes to developer with fewest requests
- `random`: Random selection

## 📈 Benefits over Render

1. **Faster**: Edge functions start in <50ms
2. **More Reliable**: Better connection handling
3. **Slack Optimized**: Built for webhook forwarding
4. **Global**: Edge network reduces latency
5. **Simpler**: No complex proxy middleware

## 🧪 Testing

```bash
# Test health endpoint
curl https://your-domain.vercel.app/health

# Test with Slack-like request
curl -X POST https://your-domain.vercel.app/slack/events \
  -H "Content-Type: application/json" \
  -H "X-Slack-Signature: v0=test" \
  -d '{"type":"url_verification","challenge":"test"}'
```

## 🐛 Debugging

Check Vercel function logs in your dashboard:
- Look for `[PROXY] →` messages showing routing
- Check `[PROXY] ✅` for successful forwards
- Watch for `[PROXY] ❌` errors with timing info

## 🔧 Adding New Developers

Just add environment variables:
```bash
DEVELOPER_NEWDEV_SLACK_APP=https://newdev.ngrok-free.app
```

The load balancer will automatically pick up the new developer! 