# n8n-nodes-x402-bazaar

**n8n community node for [x402 Bazaar](https://x402bazaar.org)** — the autonomous API marketplace where AI agents pay per-call with USDC.

Access **71+ APIs** directly from your n8n workflows with automatic on-chain USDC payments on **Base** or **SKALE on Base** (ultra-low gas).

[![npm](https://img.shields.io/npm/v/@wintyx/n8n-nodes-x402-bazaar)](https://www.npmjs.com/package/@wintyx/n8n-nodes-x402-bazaar)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Installation

### Community Nodes (recommended)

1. Go to **Settings > Community Nodes** in your n8n instance
2. Select **Install**
3. Enter `@wintyx/n8n-nodes-x402-bazaar`
4. Agree to the risks and click **Install**

### Manual Installation

```bash
cd ~/.n8n/nodes
npm install @wintyx/n8n-nodes-x402-bazaar
```

Then restart n8n.

## Credentials Setup

1. Create new **x402 Bazaar** credentials in n8n
2. Enter your **wallet private key** (hex, 0x-prefixed) — used locally to sign USDC payments, never sent to any server
3. Choose your **network**: Base (mainnet) or SKALE on Base (ultra-low gas)
4. Set a **max budget** (USDC) as a safety cap per workflow execution
5. Click **Test** to verify connectivity

> You need USDC on Base or SKALE on Base in your wallet to pay for API calls. Most APIs cost 0.001–0.05 USDC per call.
>
> **Need USDC?** Bridge from any chain (ETH, Polygon, Arbitrum, Optimism) → SKALE in 1 click: [x402bazaar.org/fund](https://x402bazaar.org/fund)

## Operations

### Call API

Call any API on the x402 Bazaar marketplace. The service dropdown loads dynamically — when new APIs are registered on the marketplace, they appear automatically.

- **Service**: Dynamic dropdown with all available APIs, showing name, price, and verification status
- **HTTP Method**: Auto-detect (GET/POST), or manual override
- **Parameters**: Key-value pairs for query parameters (GET) or JSON body (POST)

The node handles the x402 payment protocol automatically:
1. Sends the initial request
2. If the API requires payment (HTTP 402), sends USDC on-chain
3. Retries with the transaction hash as proof of payment
4. Returns the API response + payment metadata

### List Services

Browse all available APIs on the marketplace with optional category filtering (AI, Data, Text, Tools, Web, etc.).

### Get Balance

Check your wallet's USDC balance and budget status (spent/remaining for the current execution).

### Get Service Info

Get detailed information about a specific API: description, price, verification status, owner, tags, and more.

## Example Workflow

1. **x402 Bazaar** (List Services) → See all available APIs
2. **x402 Bazaar** (Call API: Web Search, q="n8n automation") → Search the web (0.005 USDC)
3. **x402 Bazaar** (Call API: Summarize, text=...) → Summarize results (0.01 USDC)
4. **Slack** → Send the summary to a channel

## API Categories

| Category | Examples | Price Range |
|----------|----------|-------------|
| **Web** | Search, Scrape, Twitter, News, Reddit | 0.003–0.005 USDC |
| **AI** | Image (DALL-E 3), Sentiment, Code | 0.005–0.05 USDC |
| **Data** | Weather, Crypto, Stocks, Geocoding | 0.001–0.02 USDC |
| **Text** | Translate, Summarize, Markdown | 0.001–0.01 USDC |
| **Intelligence** | SEO Audit, Domain Report, Lead Score | 0.005–0.01 USDC |
| **Tools** | QR Code, Hash, UUID, DNS, Whois | 0.001–0.005 USDC |
| **Validation** | Email, Phone, URL, JSON, JWT | 0.001–0.005 USDC |

## Payment Details

Every paid API call includes `_x402_payment` metadata in the output:

```json
{
  "success": true,
  "results": [...],
  "_x402_payment": {
    "service": "x402 Web Search",
    "amount": 0.005,
    "txHash": "0xabc123...",
    "explorer": "https://basescan.org/tx/0xabc123...",
    "from": "0xYourWallet...",
    "network": "base",
    "totalSpent": 0.005,
    "budgetRemaining": 0.995
  }
}
```

## Links

- [x402 Bazaar](https://x402bazaar.org) — Live marketplace
- [Documentation](https://x402bazaar.org/docs) — API docs
- [GitHub](https://github.com/Wintyx57/n8n-nodes-x402-bazaar) — Source code
- [x402 Protocol](https://x402.org) — Payment standard

## Ecosystem

x402 Bazaar is available on 8+ platforms:

| Platform | Integration |
|----------|------------|
| n8n | **This package** |
| Claude / Cursor | MCP Server |
| ChatGPT | Custom GPT Actions |
| Terminal | CLI (`npx x402-bazaar`) |
| Python | LangChain package |
| Telegram | Interactive bot |
| Auto-GPT | Plugin |
| AI Agents | Bazaar Discovery |

## License

MIT
