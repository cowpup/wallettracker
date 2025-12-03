'use client'

import { useState } from 'react'

interface WalletFlow {
  address: string
  totalInflowSol: number
  totalOutflowSol: number
  netFlowSol: number
  transactionCount: number
  firstTxTime: number | null
  lastTxTime: number | null
  error?: string
}

interface AnalysisResult {
  results: WalletFlow[]
  aggregate: {
    totalWallets: number
    totalInflowSol: number
    totalOutflowSol: number
    netFlowSol: number
    totalTransactions: number
    errors: number
  }
  solPrice: number
}

function formatDate(timestamp: number | null): string {
  if (!timestamp) return 'N/A'
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSol(amount: number): string {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}

function formatUsd(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

const BATCH_SIZE = 25 // Process 25 wallets at a time to avoid timeouts

export default function Home() {
  const [walletInput, setWalletInput] = useState('')
  const [rpcUrl, setRpcUrl] = useState('')
  const [maxTx, setMaxTx] = useState(100)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })

  const analyzeBatch = async (wallets: string[], rpcUrl: string | undefined, maxTx: number): Promise<{ results: WalletFlow[], solPrice: number }> => {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallets,
        rpcUrl: rpcUrl || undefined,
        maxTransactions: maxTx,
      }),
    })

    const text = await response.text()

    let data
    try {
      data = JSON.parse(text)
    } catch {
      if (text.includes('timeout') || text.includes('FUNCTION_INVOCATION_TIMEOUT')) {
        throw new Error('Request timed out')
      }
      throw new Error('Server error')
    }

    if (!response.ok) {
      throw new Error(data.error || 'Analysis failed')
    }

    return { results: data.results, solPrice: data.solPrice }
  }

  const handleAnalyze = async () => {
    const wallets = walletInput
      .split('\n')
      .map((w) => w.trim())
      .filter((w) => w.length > 0)

    if (wallets.length === 0) {
      setError('Please enter at least one wallet address')
      return
    }

    if (wallets.length > 10000) {
      setError('Maximum 10,000 wallets per request')
      return
    }

    setLoading(true)
    setError(null)
    setResults(null)
    setProgress({ current: 0, total: wallets.length })

    const allResults: WalletFlow[] = []
    let solPrice = 0
    let batchErrors = 0

    try {
      // Process in batches
      for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
        const batch = wallets.slice(i, i + BATCH_SIZE)

        try {
          const batchResult = await analyzeBatch(batch, rpcUrl || undefined, maxTx)
          allResults.push(...batchResult.results)
          if (batchResult.solPrice > 0) {
            solPrice = batchResult.solPrice
          }
        } catch (err) {
          // If a batch fails, mark all wallets in that batch as errored
          batchErrors++
          batch.forEach(address => {
            allResults.push({
              address,
              totalInflowSol: 0,
              totalOutflowSol: 0,
              netFlowSol: 0,
              transactionCount: 0,
              firstTxTime: null,
              lastTxTime: null,
              error: err instanceof Error ? err.message : 'Batch failed',
            })
          })
        }

        setProgress({ current: Math.min(i + BATCH_SIZE, wallets.length), total: wallets.length })
      }

      // Calculate aggregates from all results
      const aggregate = {
        totalWallets: allResults.length,
        totalInflowSol: allResults.reduce((sum, r) => sum + r.totalInflowSol, 0),
        totalOutflowSol: allResults.reduce((sum, r) => sum + r.totalOutflowSol, 0),
        netFlowSol: allResults.reduce((sum, r) => sum + r.netFlowSol, 0),
        totalTransactions: allResults.reduce((sum, r) => sum + r.transactionCount, 0),
        errors: allResults.filter((r) => r.error).length,
      }

      setResults({ results: allResults, aggregate, solPrice })

      if (batchErrors > 0) {
        setError(`Completed with ${batchErrors} failed batch(es). Some wallets may have errors.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
      setProgress({ current: 0, total: 0 })
    }
  }

  const exportJson = () => {
    if (!results) return
    const blob = new Blob([JSON.stringify(results, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'wallet-analysis.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportCsv = () => {
    if (!results) return

    const solPrice = results.solPrice || 0
    const headers = [
      'Wallet',
      'Inflow (SOL)',
      'Outflow (SOL)',
      'Net Flow (SOL)',
      'Inflow (USD)',
      'Outflow (USD)',
      'Net Flow (USD)',
      'Transactions',
      'First Tx',
      'Last Tx',
      'Error',
    ]
    const rows = results.results.map((wallet) => [
      wallet.address,
      wallet.totalInflowSol.toFixed(4),
      wallet.totalOutflowSol.toFixed(4),
      wallet.netFlowSol.toFixed(4),
      (wallet.totalInflowSol * solPrice).toFixed(2),
      (wallet.totalOutflowSol * solPrice).toFixed(2),
      (wallet.netFlowSol * solPrice).toFixed(2),
      wallet.transactionCount.toString(),
      wallet.firstTxTime ? new Date(wallet.firstTxTime * 1000).toISOString() : '',
      wallet.lastTxTime ? new Date(wallet.lastTxTime * 1000).toISOString() : '',
      wallet.error || '',
    ])

    const csvContent = [
      `# SOL Price: $${solPrice.toFixed(2)}`,
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'wallet-analysis.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Solana Wallet Flow Tracker</h1>
        <p className="text-gray-400">
          Analyze SOL inflows and outflows across multiple wallets
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Input Section */}
        <div className="bg-zinc-900 rounded-lg p-6 border border-zinc-800">
          <label className="block mb-2 font-medium">
            Wallet Addresses
            <span className="text-gray-500 font-normal ml-2">(one per line, max 10,000)</span>
          </label>
          <textarea
            value={walletInput}
            onChange={(e) => setWalletInput(e.target.value)}
            placeholder="Enter wallet addresses...
7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK"
            className="w-full h-40 bg-zinc-950 border border-zinc-700 rounded-lg p-3 font-mono text-sm resize-none focus:outline-none focus:border-purple-500"
          />

          <button
            onClick={() => setShowSettings(!showSettings)}
            className="mt-4 text-sm text-gray-400 hover:text-white flex items-center gap-1"
          >
            <svg
              className={`w-4 h-4 transition-transform ${showSettings ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Advanced Settings
          </button>

          {showSettings && (
            <div className="mt-4 space-y-4 p-4 bg-zinc-950 rounded-lg">
              <div>
                <label className="block mb-1 text-sm text-gray-400">
                  Custom RPC URL
                  <span className="text-gray-600 ml-1">(optional)</span>
                </label>
                <input
                  type="text"
                  value={rpcUrl}
                  onChange={(e) => setRpcUrl(e.target.value)}
                  placeholder="https://mainnet.helius-rpc.com/?api-key=..."
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-purple-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Recommended: Use Helius, QuickNode, or Alchemy for better rate limits
                </p>
              </div>
              <div>
                <label className="block mb-1 text-sm text-gray-400">
                  Max Transactions per Wallet
                </label>
                <input
                  type="number"
                  value={maxTx}
                  onChange={(e) => setMaxTx(Number(e.target.value))}
                  min={10}
                  max={500}
                  className="w-24 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>
          )}

          <button
            onClick={handleAnalyze}
            disabled={loading}
            className="mt-6 w-full bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:cursor-not-allowed text-white font-medium py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                {progress.total > 0
                  ? `Analyzing... ${progress.current} / ${progress.total} wallets`
                  : 'Analyzing...'}
              </>
            ) : (
              'Analyze Wallets'
            )}
          </button>

          {loading && progress.total > 0 && (
            <div className="mt-3">
              <div className="w-full bg-zinc-800 rounded-full h-2">
                <div
                  className="bg-purple-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1 text-center">
                Processing in batches of {BATCH_SIZE} to avoid timeouts
              </p>
            </div>
          )}

          {error && (
            <div className="mt-4 p-4 bg-red-900/30 border border-red-800 rounded-lg text-red-300">
              {error}
            </div>
          )}
        </div>

        {/* Aggregate Results */}
        <div className="bg-zinc-900 rounded-lg p-6 border border-zinc-800">
          <h2 className="text-xl font-semibold mb-4">Summary</h2>
          
          {!results ? (
            <div className="text-gray-500 text-center py-12">
              Enter wallet addresses and click Analyze to see results
            </div>
          ) : (
            <div className="space-y-4">
              {results.solPrice > 0 && (
                <div className="text-xs text-gray-500 text-right">
                  SOL Price: {formatUsd(results.solPrice)}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-zinc-950 rounded-lg p-4">
                  <div className="text-gray-400 text-sm">Total Inflow</div>
                  <div className="text-2xl font-bold text-green-400">
                    {formatSol(results.aggregate.totalInflowSol)} SOL
                  </div>
                  {results.solPrice > 0 && (
                    <div className="text-sm text-green-400/70">
                      {formatUsd(results.aggregate.totalInflowSol * results.solPrice)}
                    </div>
                  )}
                </div>
                <div className="bg-zinc-950 rounded-lg p-4">
                  <div className="text-gray-400 text-sm">Total Outflow</div>
                  <div className="text-2xl font-bold text-red-400">
                    {formatSol(results.aggregate.totalOutflowSol)} SOL
                  </div>
                  {results.solPrice > 0 && (
                    <div className="text-sm text-red-400/70">
                      {formatUsd(results.aggregate.totalOutflowSol * results.solPrice)}
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-zinc-950 rounded-lg p-4">
                <div className="text-gray-400 text-sm">Net Flow</div>
                <div
                  className={`text-3xl font-bold ${
                    results.aggregate.netFlowSol >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {results.aggregate.netFlowSol >= 0 ? '+' : ''}
                  {formatSol(results.aggregate.netFlowSol)} SOL
                </div>
                {results.solPrice > 0 && (
                  <div className={`text-lg ${results.aggregate.netFlowSol >= 0 ? 'text-green-400/70' : 'text-red-400/70'}`}>
                    {results.aggregate.netFlowSol >= 0 ? '+' : ''}
                    {formatUsd(results.aggregate.netFlowSol * results.solPrice)}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="bg-zinc-950 rounded-lg p-3">
                  <span className="text-gray-400">Wallets:</span>{' '}
                  <span className="font-medium">{results.aggregate.totalWallets}</span>
                </div>
                <div className="bg-zinc-950 rounded-lg p-3">
                  <span className="text-gray-400">Transactions:</span>{' '}
                  <span className="font-medium">{results.aggregate.totalTransactions}</span>
                </div>
              </div>

              {results.aggregate.errors > 0 && (
                <div className="text-yellow-500 text-sm">
                  ⚠️ {results.aggregate.errors} wallet(s) had errors
                </div>
              )}

              <div className="flex gap-2 mt-2">
                <button
                  onClick={exportCsv}
                  className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white py-2 px-4 rounded-lg transition-colors text-sm"
                >
                  Export CSV
                </button>
                <button
                  onClick={exportJson}
                  className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white py-2 px-4 rounded-lg transition-colors text-sm"
                >
                  Export JSON
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detailed Results */}
      {results && (
        <div className="mt-6 bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <div className="p-4 border-b border-zinc-800">
            <h2 className="text-xl font-semibold">Wallet Details</h2>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-zinc-950">
                <tr className="text-left text-sm text-gray-400">
                  <th className="p-4">Wallet</th>
                  <th className="p-4 text-right">Inflow (SOL)</th>
                  <th className="p-4 text-right">Inflow (USD)</th>
                  <th className="p-4 text-right">Outflow (SOL)</th>
                  <th className="p-4 text-right">Outflow (USD)</th>
                  <th className="p-4 text-right">Net (SOL)</th>
                  <th className="p-4 text-right">Net (USD)</th>
                  <th className="p-4 text-right">Txs</th>
                  <th className="p-4">First Tx</th>
                  <th className="p-4">Last Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {results.results.map((wallet) => (
                  <tr key={wallet.address} className="hover:bg-zinc-800/50">
                    <td className="p-4">
                      <div className="font-mono text-sm">
                        <span className="hidden md:inline">{wallet.address}</span>
                        <span className="md:hidden">{shortenAddress(wallet.address)}</span>
                      </div>
                      {wallet.error && (
                        <div className="text-red-400 text-xs mt-1">Error: {wallet.error}</div>
                      )}
                    </td>
                    <td className="p-4 text-right text-green-400">
                      {formatSol(wallet.totalInflowSol)}
                    </td>
                    <td className="p-4 text-right text-green-400/70 text-sm">
                      {results.solPrice > 0 ? formatUsd(wallet.totalInflowSol * results.solPrice) : '-'}
                    </td>
                    <td className="p-4 text-right text-red-400">
                      {formatSol(wallet.totalOutflowSol)}
                    </td>
                    <td className="p-4 text-right text-red-400/70 text-sm">
                      {results.solPrice > 0 ? formatUsd(wallet.totalOutflowSol * results.solPrice) : '-'}
                    </td>
                    <td
                      className={`p-4 text-right font-medium ${
                        wallet.netFlowSol >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {wallet.netFlowSol >= 0 ? '+' : ''}
                      {formatSol(wallet.netFlowSol)}
                    </td>
                    <td
                      className={`p-4 text-right text-sm ${
                        wallet.netFlowSol >= 0 ? 'text-green-400/70' : 'text-red-400/70'
                      }`}
                    >
                      {results.solPrice > 0 ? (
                        <>
                          {wallet.netFlowSol >= 0 ? '+' : ''}
                          {formatUsd(wallet.netFlowSol * results.solPrice)}
                        </>
                      ) : '-'}
                    </td>
                    <td className="p-4 text-right text-gray-400">{wallet.transactionCount}</td>
                    <td className="p-4 text-sm text-gray-400">{formatDate(wallet.firstTxTime)}</td>
                    <td className="p-4 text-sm text-gray-400">{formatDate(wallet.lastTxTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <footer className="mt-12 text-center text-sm text-gray-500">
        <p>
          Tip: For better performance, use a dedicated RPC from{' '}
          <a
            href="https://helius.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:underline"
          >
            Helius
          </a>
          ,{' '}
          <a
            href="https://quicknode.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:underline"
          >
            QuickNode
          </a>
          , or{' '}
          <a
            href="https://alchemy.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:underline"
          >
            Alchemy
          </a>
        </p>
      </footer>
    </main>
  )
}
