# Solana Wallet Flow Tracker

A web-based tool to analyze SOL inflows and outflows across multiple Solana wallets.

![Screenshot](screenshot.png)

## Features

- Track SOL inflows and outflows for up to 10 wallets at once
- View aggregate totals and per-wallet breakdowns
- Export results as JSON
- Custom RPC endpoint support for better rate limits
- Mobile responsive UI

## Deploy to Vercel

### One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/solana-wallet-tracker)

### Manual Deploy

1. Push this code to a GitHub repository
2. Go to [vercel.com](https://vercel.com) and sign in
3. Click "New Project" and import your repository
4. (Optional) Add environment variable `SOLANA_RPC_URL` for a custom RPC
5. Click Deploy

## Local Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Open http://localhost:3000
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SOLANA_RPC_URL` | Custom Solana RPC endpoint | No (defaults to public RPC) |

## Recommended RPC Providers

The public Solana RPC has strict rate limits. For production use, get a free API key from:

- [Helius](https://helius.xyz) - Free tier: 100k requests/month
- [QuickNode](https://quicknode.com) - Free tier available
- [Alchemy](https://alchemy.com) - Free tier available

## API Usage

You can also call the API directly:

```bash
curl -X POST https://your-app.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "wallets": ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
    "maxTransactions": 100
  }'
```

### Request Body

```json
{
  "wallets": ["address1", "address2"],
  "rpcUrl": "https://your-rpc-url.com",
  "maxTransactions": 100
}
```

### Response

```json
{
  "results": [
    {
      "address": "...",
      "totalInflowSol": 123.45,
      "totalOutflowSol": 67.89,
      "netFlowSol": 55.56,
      "transactionCount": 100,
      "firstTxTime": 1700000000,
      "lastTxTime": 1702000000
    }
  ],
  "aggregate": {
    "totalWallets": 1,
    "totalInflowSol": 123.45,
    "totalOutflowSol": 67.89,
    "netFlowSol": 55.56,
    "totalTransactions": 100,
    "errors": 0
  }
}
```

## License

MIT
