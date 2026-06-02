import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import { randomBytes } from "crypto";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { base, polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ─── Chain Configuration ────────────────────────────────────────────────────

interface ChainConfig {
  rpcUrl: string;
  usdcContract: Address;
  explorer: string;
  viemChain: object;
  decimals: number;
  displayName: string;
}

const CHAINS: Record<string, ChainConfig> = {
  base: {
    rpcUrl: "https://mainnet.base.org",
    usdcContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer: "https://basescan.org",
    viemChain: base,
    decimals: 6,
    displayName: "Base",
  },
  skale: {
    rpcUrl: "https://skale-base.skalenodes.com/v1/base",
    usdcContract: "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
    explorer: "https://skale-base-explorer.skalenodes.com",
    viemChain: {
      id: 1187947933,
      name: "SKALE on Base",
      nativeCurrency: { name: "CREDITS", symbol: "CREDITS", decimals: 18 },
      rpcUrls: {
        default: {
          http: ["https://skale-base.skalenodes.com/v1/base"],
        },
      },
    },
    decimals: 6,
    displayName: "SKALE on Base",
  },
  polygon: {
    rpcUrl: "https://polygon-bor-rpc.publicnode.com",
    usdcContract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as `0x${string}`,
    explorer: "https://polygonscan.com",
    viemChain: polygon,
    decimals: 6,
    displayName: "Polygon",
  },
};

const USDC_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ─── Payment Helpers ────────────────────────────────────────────────────────

/**
 * Internal helper: sends a USDC transfer with a raw BigInt amount (micro-USDC, 6 decimals).
 * Used by both sendUsdcPayment (legacy) and sendSplitPayment (native split).
 */
async function _sendUsdcRaw(
  privateKey: string,
  chainCfg: ChainConfig,
  recipient: Address,
  amountRaw: bigint,
): Promise<{ txHash: Hash; explorer: string; from: string }> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: chainCfg.viemChain as Parameters<
      typeof createWalletClient
    >[0]["chain"],
    transport: http(chainCfg.rpcUrl),
  });

  const publicClient = createPublicClient({
    chain: chainCfg.viemChain as Parameters<
      typeof createPublicClient
    >[0]["chain"],
    transport: http(chainCfg.rpcUrl),
  });

  // Check balance first
  const balance = await publicClient.readContract({
    address: chainCfg.usdcContract,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  if (balance < amountRaw) {
    const divisor = 10 ** chainCfg.decimals;
    throw new Error(
      `Insufficient USDC balance: ${(Number(balance) / divisor).toFixed(4)} available, ${(Number(amountRaw) / divisor).toFixed(4)} required`,
    );
  }

  // Send USDC transfer
  const txHash = await walletClient.writeContract({
    address: chainCfg.usdcContract,
    abi: USDC_ABI,
    functionName: "transfer",
    args: [recipient, amountRaw],
    chain: null,
  });

  // Wait for 1 confirmation
  await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  return {
    txHash,
    explorer: `${chainCfg.explorer}/tx/${txHash}`,
    from: account.address,
  };
}

/**
 * Send a USDC payment expressed as a floating-point USDC amount.
 * Used for legacy single-payment mode and registerService (listing fee 100% to platform).
 */
async function sendUsdcPayment(
  privateKey: string,
  network: string,
  recipient: Address,
  amountUsdc: number,
): Promise<{ txHash: Hash; explorer: string; from: string }> {
  const chainCfg = CHAINS[network] || CHAINS.base;
  const amountRaw = parseUnits(amountUsdc.toString(), chainCfg.decimals);
  return _sendUsdcRaw(privateKey, chainCfg, recipient, amountRaw);
}

/**
 * Result returned by sendSplitPayment.
 */
interface SplitPaymentResult {
  txHashProvider: Hash;
  txHashPlatform: Hash;
  explorerProvider: string;
  explorerPlatform: string;
  from: string;
  providerAmountUsdc: number;
  platformAmountUsdc: number;
}

/**
 * Native 95/5 split: sends two separate USDC transfers.
 *   - Tx1: floor(total * 95 / 100) micro-USDC -> providerWallet
 *   - Tx2: total - providerAmount micro-USDC   -> platformRecipient
 *
 * Uses BigInt integer arithmetic (6-decimal micro-USDC) to avoid floating-point
 * rounding, matching the server-side formula exactly.
 *
 * NOTE: This operation is NOT atomic. If Tx1 succeeds but Tx2 fails, the caller
 * should catch the error and send only X-Payment-TxHash-Provider; the backend
 * will fall back to recording a pending_payout for the platform share.
 */
async function sendSplitPayment(
  privateKey: string,
  network: string,
  providerWallet: Address,
  platformRecipient: Address,
  totalAmountUsdc: number,
): Promise<SplitPaymentResult> {
  const chainCfg = CHAINS[network] || CHAINS.base;

  // Integer arithmetic using chain-specific decimals (6 for Base/Polygon/SKALE — SKALE USDC is 6 decimals, verified on-chain)
  const totalRaw = parseUnits(totalAmountUsdc.toString(), chainCfg.decimals);
  const providerRaw = (totalRaw * 95n) / 100n;
  const platformRaw = totalRaw - providerRaw;

  // Guard: both sub-amounts must be non-zero (prices below ~0.0001 USDC are rejected)
  if (providerRaw === 0n || platformRaw === 0n) {
    throw new Error(
      `Amount too small for split payment: ${totalAmountUsdc} USDC produces a zero sub-amount (minimum ~0.0001 USDC)`,
    );
  }

  // Tx1: 95% to provider (mandatory)
  const providerResult = await _sendUsdcRaw(
    privateKey,
    chainCfg,
    providerWallet,
    providerRaw,
  );

  // Tx2: 5% to platform
  const platformResult = await _sendUsdcRaw(
    privateKey,
    chainCfg,
    platformRecipient,
    platformRaw,
  );

  const divisor = 10 ** chainCfg.decimals;
  return {
    txHashProvider: providerResult.txHash,
    txHashPlatform: platformResult.txHash,
    explorerProvider: providerResult.explorer,
    explorerPlatform: platformResult.explorer,
    from: providerResult.from,
    providerAmountUsdc: Number(providerRaw) / divisor,
    platformAmountUsdc: Number(platformRaw) / divisor,
  };
}

async function getUsdcBalance(
  privateKey: string,
  network: string,
): Promise<{ balance: number; address: string; network: string }> {
  const chainCfg = CHAINS[network] || CHAINS.base;
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const publicClient = createPublicClient({
    chain: chainCfg.viemChain as Parameters<
      typeof createPublicClient
    >[0]["chain"],
    transport: http(chainCfg.rpcUrl),
  });

  const balance = await publicClient.readContract({
    address: chainCfg.usdcContract,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  return {
    balance: Number(balance) / 10 ** chainCfg.decimals,
    address: account.address,
    network: chainCfg.displayName,
  };
}

// ─── Facilitator Payment (Polygon EIP-3009, gas-free) ───────────────────────
//
// Parity with mcp-server.mjs (~l.573-729). When the backend's 402 response
// includes a `facilitator` URL in payment_details, the agent does NOT broadcast
// an on-chain transfer itself. Instead it signs an EIP-3009
// TransferWithAuthorization off-chain (zero gas) and POSTs it to the
// facilitator's /settle endpoint; the facilitator submits the transaction
// on-chain and sponsors the gas. The returned txHash is then used as the
// standard X-Payment-TxHash payment proof on retry.
//
// Only chains whose USDC contract implements EIP-3009 are eligible. We list
// their EIP-712 domain separators here (Polygon is the production target).

interface Eip3009Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

const EIP3009_DOMAINS: Record<string, Eip3009Domain> = {
  polygon: {
    name: "USD Coin",
    version: "2",
    chainId: 137,
    verifyingContract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  base: {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  // SKALE: custom USDC without EIP-3009 — facilitator flow not available.
};

interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/**
 * Sign an EIP-3009 TransferWithAuthorization message off-chain (zero gas).
 * Mirrors signEIP3009Auth() in mcp-server.mjs.
 */
async function signEip3009Auth(
  privateKey: string,
  network: string,
  amountRaw: bigint,
  to: Address,
  validAfter: number,
  validBefore: number,
): Promise<{ signature: Hex; authorization: Eip3009Authorization }> {
  const domain = EIP3009_DOMAINS[network];
  if (!domain) {
    throw new Error(
      `EIP-3009 facilitator not supported on chain "${network}". Supported: ${Object.keys(EIP3009_DOMAINS).join(", ")}`,
    );
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: CHAINS[network]?.viemChain as Parameters<
      typeof createWalletClient
    >[0]["chain"],
    transport: http((CHAINS[network] || CHAINS.base).rpcUrl),
  });

  // 32-byte random nonce (hex). randomBytes from Node's crypto — same as MCP.
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: account.address,
    to,
    value: amountRaw,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };

  const signature = await walletClient.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    signature,
    authorization: {
      from: account.address,
      to,
      value: amountRaw.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };
}

interface FacilitatorResult {
  txHash: string;
  from: string;
  recipient: Address;
  amountUsdc: number;
}

/**
 * Pay a Polygon (or other EIP-3009) service via the x402 facilitator.
 * Mirrors sendViaFacilitator() in mcp-server.mjs (~l.647).
 *
 * Steps:
 *   1. Sign EIP-3009 TransferWithAuthorization off-chain (zero gas).
 *   2. POST { x402Version, paymentPayload, paymentRequirements } to
 *      `${facilitatorUrl}/settle`. The facilitator broadcasts on-chain.
 *   3. Return the facilitator's txHash for use as X-Payment-TxHash on retry.
 *
 * This function performs the SETTLEMENT only. The caller retries the API
 * request with the returned txHash, exactly like the legacy flow.
 *
 * Uses the n8n httpRequest helper for the /settle POST so the call is visible
 * in n8n's execution log and respects proxy settings.
 */
async function payViaFacilitator(
  httpRequest: IExecuteFunctions["helpers"]["httpRequest"],
  privateKey: string,
  network: string,
  facilitatorUrl: string,
  recipient: Address,
  apiUrl: string,
  amountUsdc: number,
): Promise<FacilitatorResult> {
  const chainCfg = CHAINS[network] || CHAINS.base;
  const amountRaw = parseUnits(amountUsdc.toString(), chainCfg.decimals);

  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 300; // 5 minutes

  // Step 1: off-chain EIP-3009 signature (zero gas)
  const { signature, authorization } = await signEip3009Auth(
    privateKey,
    network,
    amountRaw,
    recipient,
    validAfter,
    validBefore,
  );

  // Step 2: build x402 payment payload + requirements (Version 1, exact scheme)
  const paymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network,
    payload: { signature, authorization },
  };

  const paymentRequirements = {
    scheme: "exact",
    network,
    maxAmountRequired: amountRaw.toString(),
    resource: apiUrl,
    description: "x402 Bazaar API payment",
    mimeType: "application/json",
    payTo: recipient,
    asset: chainCfg.usdcContract,
    maxTimeoutSeconds: 60,
  };

  // Step 3: POST to facilitator /settle — facilitator executes on-chain.
  const settleUrl = `${facilitatorUrl.replace(/\/$/, "")}/settle`;
  const settleRes = (await httpRequest({
    method: "POST",
    url: settleUrl,
    headers: { "Content-Type": "application/json" },
    body: { x402Version: 1, paymentPayload, paymentRequirements },
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
  })) as { statusCode: number; body: Record<string, unknown> };

  const settleData = (settleRes.body || {}) as {
    success?: boolean;
    transaction?: string;
    errorReason?: string;
    errorMessage?: string;
  };

  if (
    settleRes.statusCode < 200 ||
    settleRes.statusCode > 299 ||
    !settleData.success ||
    !settleData.transaction
  ) {
    throw new Error(
      `Facilitator settlement failed (HTTP ${settleRes.statusCode}): ${settleData.errorReason || "unknown"} — ${settleData.errorMessage || JSON.stringify(settleData)}`,
    );
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return {
    txHash: settleData.transaction,
    from: account.address,
    recipient,
    amountUsdc,
  };
}

// ─── Consumer Protection: detect not_charged / refunded ─────────────────────
//
// Parity with mcp-server.mjs (~l.1104-1144). The backend proxy returns the
// payment outcome in the response body via `_payment_status`:
//   - "not_charged": the call did not bill the agent (e.g. missing required
//     parameter, upstream returned an error before charging). The agent's
//     USDC was NOT spent — the call must NOT be treated as a billed success.
//   - "refunded": the agent was charged on-chain but the response failed
//     validation, so the platform refunded the payment on-chain.
// In both cases the API call did not deliver a paid result, so the node must
// surface a clear error/warning instead of a silent success.

const PAYMENT_FAILURE_STATUSES = new Set(["not_charged", "refunded"]);

interface PaymentStatusInfo {
  status: string;
  refundTxHash?: string;
  refundWallet?: string;
  reason?: string;
}

/**
 * Returns payment-failure info if the response body signals not_charged /
 * refunded, otherwise null. Reads the same shape the backend emits
 * (`_payment_status` plus an optional `_x402` block).
 */
function detectPaymentFailure(
  body: Record<string, unknown> | undefined | null,
): PaymentStatusInfo | null {
  if (!body || typeof body !== "object") return null;
  const status = body._payment_status as string | undefined;
  if (!status || !PAYMENT_FAILURE_STATUSES.has(status)) return null;

  const x402 = (body._x402 as Record<string, unknown>) || {};
  return {
    status,
    refundTxHash: (x402.refund_tx_hash as string) || undefined,
    refundWallet: (x402.refund_wallet as string) || undefined,
    reason: (x402.reason as string) || (body.error as string) || undefined,
  };
}

// ─── Service Info Parser ────────────────────────────────────────────────────

interface ServiceMeta {
  path: string;
  name: string;
  price: number;
  url: string;
  method: string;
  isNative: boolean;
}

// Known POST-only endpoints (cannot be auto-detected from /api/services)
const POST_ENDPOINTS = new Set([
  "/api/code",
  "/api/code-review",
  "/api/math",
  "/api/regex",
  "/api/contract-risk",
  "/api/email-parse",
  "/api/table-insights",
  "/api/domain-report",
  "/api/seo-audit",
  "/api/lead-score",
  "/api/crypto-intelligence",
]);

// ─── Node Class ─────────────────────────────────────────────────────────────

export class X402Bazaar implements INodeType {
  description: INodeTypeDescription = {
    displayName: "x402 Bazaar",
    name: "x402Bazaar",
    icon: "file:x402-bazaar.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description:
      "Access 70+ APIs from the x402 Bazaar marketplace with automatic USDC payments on Base, SKALE or Polygon",
    defaults: {
      name: "x402 Bazaar",
    },
    usableAsTool: true,
    inputs: ["main"],
    outputs: ["main"],
    credentials: [
      {
        name: "x402BazaarCredentials",
        required: true,
      },
    ],
    properties: [
      // ── Operation selector ──
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Call API",
            value: "callApi",
            description:
              "Call any API on the marketplace with automatic x402 payment",
            action: "Call an API on x402 Bazaar",
          },
          {
            name: "List Services",
            value: "listServices",
            description: "Browse all available APIs on the marketplace",
            action: "List available services",
          },
          {
            name: "Get Balance",
            value: "getBalance",
            description: "Check your wallet USDC balance and budget status",
            action: "Get wallet balance",
          },
          {
            name: "Get Service Info",
            value: "getServiceInfo",
            description:
              "Get detailed information about a specific API service",
            action: "Get service details",
          },
          {
            name: "Register Service",
            value: "registerService",
            description:
              "Register your API on the x402 Bazaar marketplace (1 USDC)",
            action: "Register a new service on the marketplace",
          },
        ],
        default: "callApi",
      },

      // ── Call API: Service dropdown ──
      {
        displayName: "Service",
        name: "servicePath",
        type: "options",
        typeOptions: {
          loadOptionsMethod: "getServices",
        },
        required: true,
        default: "",
        displayOptions: {
          show: { operation: ["callApi"] },
        },
        description:
          "Select the API to call. This list is fetched live from the marketplace.",
      },

      // ── Call API: HTTP method override ──
      {
        displayName: "HTTP Method",
        name: "httpMethod",
        type: "options",
        options: [
          {
            name: "Auto-Detect",
            value: "auto",
            description:
              "GET for most APIs, POST for code/math/intelligence endpoints",
          },
          { name: "GET", value: "GET" },
          { name: "POST (JSON Body)", value: "POST" },
        ],
        default: "auto",
        displayOptions: {
          show: { operation: ["callApi"] },
        },
        description:
          "HTTP method override. Auto-detect is correct for most APIs.",
      },

      // ── Call API: Parameters ──
      {
        displayName: "Parameters",
        name: "parameters",
        type: "fixedCollection",
        typeOptions: { multipleValues: true },
        displayOptions: {
          show: { operation: ["callApi"] },
        },
        default: {},
        placeholder: "Add Parameter",
        description:
          "Query parameters (GET) or body fields (POST) to send with the API call",
        options: [
          {
            name: "entries",
            displayName: "Parameter",
            values: [
              {
                displayName: "Key",
                name: "key",
                type: "string",
                default: "",
                placeholder: "q",
                description: 'Parameter name (e.g. "q", "city", "coin")',
              },
              {
                displayName: "Value",
                name: "value",
                type: "string",
                default: "",
                placeholder: "artificial intelligence",
                description: "Parameter value",
              },
            ],
          },
        ],
      },

      // ── List Services: Category filter ──
      {
        displayName: "Category",
        name: "categoryFilter",
        type: "options",
        displayOptions: {
          show: { operation: ["listServices"] },
        },
        options: [
          { name: "All Categories", value: "" },
          { name: "AI", value: "ai" },
          { name: "Data", value: "data" },
          { name: "Intelligence", value: "intelligence" },
          { name: "Misc", value: "misc" },
          { name: "Text", value: "text" },
          { name: "Tools", value: "tools" },
          { name: "Validation", value: "validation" },
          { name: "Web", value: "web" },
        ],
        default: "",
        description: "Filter services by category",
      },

      // ── Get Service Info: Service dropdown ──
      {
        displayName: "Service",
        name: "serviceInfoPath",
        type: "options",
        typeOptions: {
          loadOptionsMethod: "getServices",
        },
        required: true,
        default: "",
        displayOptions: {
          show: { operation: ["getServiceInfo"] },
        },
        description: "Select the service to get information about",
      },

      // ── Register Service: Fields ──
      {
        displayName: "Service Name",
        name: "serviceName",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: { operation: ["registerService"] },
        },
        placeholder: "My Weather API",
        description: "Name of the API service to register on the marketplace",
      },
      {
        displayName: "Service URL",
        name: "serviceUrl",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: { operation: ["registerService"] },
        },
        placeholder: "https://api.example.com/weather",
        description: "Full URL of your API endpoint (must be HTTP or HTTPS)",
      },
      {
        displayName: "Price (USDC)",
        name: "servicePrice",
        type: "number",
        required: true,
        default: 0.01,
        displayOptions: {
          show: { operation: ["registerService"] },
        },
        typeOptions: {
          minValue: 0,
          maxValue: 1000,
          numberPrecision: 4,
        },
        description: "Price per API call in USDC (0-1000)",
      },
      {
        displayName: "Description",
        name: "serviceDescription",
        type: "string",
        default: "",
        displayOptions: {
          show: { operation: ["registerService"] },
        },
        placeholder: "Returns current weather data for any city worldwide",
        description: "Description of what your API does (max 1000 characters)",
      },
      {
        displayName: "Owner Address",
        name: "ownerAddress",
        type: "string",
        default: "",
        displayOptions: {
          show: { operation: ["registerService"] },
        },
        placeholder: "0x...",
        description:
          "Ethereum wallet address that owns this service. Leave empty to use your wallet from credentials.",
      },
      {
        displayName: "Tags",
        name: "serviceTags",
        type: "string",
        default: "",
        displayOptions: {
          show: { operation: ["registerService"] },
        },
        placeholder: "weather, data, geo",
        description: "Comma-separated tags for your service (max 10 tags)",
      },
    ],
  };

  // ── Dynamic dropdown: load services from marketplace ──

  methods = {
    loadOptions: {
      async getServices(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("x402BazaarCredentials");
        const baseUrl = (
          (credentials.baseUrl as string) || "https://x402-api.onrender.com"
        ).replace(/\/$/, "");

        const servicesRaw = (await this.helpers.httpRequest({
          method: "GET",
          url: `${baseUrl}/api/services`,
          json: true,
        })) as unknown;

        const services: Array<{
          name: string;
          url: string;
          price_usdc: number;
          tags: string[];
          method?: string;
          verified_status?: string;
          description?: string;
        }> = Array.isArray(servicesRaw)
          ? servicesRaw
          : (servicesRaw as any).data || (servicesRaw as any).services || [];

        const options: INodePropertyOptions[] = [];

        for (const svc of services) {
          // Extract endpoint path for native APIs
          const nativeMatch = (svc.url || "").match(/\/api\/[\w-]+$/);
          const path = nativeMatch ? nativeMatch[0] : svc.url || "";
          const isNative = (svc.tags || []).includes("x402-native");

          const price = svc.price_usdc ?? 0;
          const verified =
            svc.verified_status === "mainnet_verified" ? " [Verified]" : "";
          const tag = isNative ? "Native" : "External";

          // Detect HTTP method
          const method =
            svc.method || (POST_ENDPOINTS.has(path) ? "POST" : "GET");

          const meta: ServiceMeta = {
            path,
            name: svc.name,
            price,
            url: svc.url,
            method,
            isNative,
          };

          options.push({
            name: `${svc.name} — ${price} USDC (${tag})${verified}`,
            value: JSON.stringify(meta),
            description: svc.description || "",
          });
        }

        options.sort((a, b) =>
          (a.name as string).localeCompare(b.name as string),
        );
        return options;
      },
    },
  };

  // ── Execute ──

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const operation = this.getNodeParameter("operation", 0) as string;

    const credentials = await this.getCredentials("x402BazaarCredentials");
    const baseUrl = (
      (credentials.baseUrl as string) || "https://x402-api.onrender.com"
    ).replace(/\/$/, "");
    const privateKey = credentials.privateKey as string;
    const network = (credentials.network as string) || "base";
    const maxBudget = (credentials.maxBudget as number) || 1.0;

    // Budget tracking across all items
    let totalSpent = 0;

    for (let i = 0; i < items.length; i++) {
      try {
        // ────────────────────────────────────────────
        // CALL API
        // ────────────────────────────────────────────
        if (operation === "callApi") {
          const serviceRaw = this.getNodeParameter("servicePath", i) as string;
          const svc: ServiceMeta = JSON.parse(serviceRaw);
          const httpMethodOverride = this.getNodeParameter(
            "httpMethod",
            i,
          ) as string;
          const paramEntries = this.getNodeParameter(
            "parameters.entries",
            i,
            [],
          ) as Array<{ key: string; value: string }>;

          // Build params
          const params: Record<string, string> = {};
          for (const p of paramEntries) {
            if (p.key) params[p.key] = p.value;
          }

          // Determine URL
          const apiUrl = svc.isNative ? `${baseUrl}${svc.path}` : svc.url;

          // Determine HTTP method
          let method: string;
          if (httpMethodOverride === "auto") {
            method = POST_ENDPOINTS.has(svc.path)
              ? "POST"
              : svc.method || "GET";
          } else {
            method = httpMethodOverride;
          }

          // Build request URL / body
          const isPost = method === "POST";
          const queryString = !isPost
            ? new URLSearchParams(params).toString()
            : "";
          const fullUrl = queryString ? `${apiUrl}?${queryString}` : apiUrl;

          // Derive wallet address
          const account = privateKeyToAccount(privateKey as `0x${string}`);

          // Step 1: Initial request (no payment header)
          const initialResponse = (await this.helpers.httpRequest({
            method: method as "GET" | "POST",
            url: fullUrl,
            headers: { "X-Agent-Wallet": account.address },
            ...(isPost ? { body: params, json: true } : { json: true }),
            returnFullResponse: true,
            ignoreHttpStatusErrors: true,
          })) as { statusCode: number; body: Record<string, unknown> };

          // Step 2: Handle 402 — pay and retry
          if (initialResponse.statusCode === 402) {
            // payment_details may include split fields when the service has an
            // external owner_address (payment_mode: "split_native").
            const paymentDetails = (
              initialResponse.body as Record<string, unknown>
            )?.payment_details as
              | {
                  amount: number;
                  recipient: string;
                  // Split-mode fields (only present for external services)
                  provider_wallet?: string;
                  split?: {
                    provider_amount: number;
                    platform_amount: number;
                  };
                  payment_mode?: string;
                  // Facilitator mode (Polygon EIP-3009, gas-free). Present only
                  // when the backend has POLYGON_FACILITATOR_URL configured.
                  facilitator?: string;
                }
              | undefined;

            if (!paymentDetails) {
              throw new NodeOperationError(
                this.getNode(),
                `${svc.name}: 402 response without payment_details`,
                { itemIndex: i },
              );
            }

            const amount = paymentDetails.amount;

            // Budget guard (total amount is unchanged whether split or legacy)
            if (totalSpent + amount > maxBudget) {
              throw new NodeOperationError(
                this.getNode(),
                `Budget exceeded: ${svc.name} costs ${amount} USDC, but only ${(maxBudget - totalSpent).toFixed(4)} USDC remaining (max budget: ${maxBudget} USDC)`,
                { itemIndex: i },
              );
            }

            // ── Detect payment mode ────────────────────────────────
            // The backend signals split mode via payment_mode: "split_native"
            // and provider_wallet. Both must be present to enable split.
            // Services without an owner_address use legacy mode (100% to platform).
            const isSplitMode =
              !!paymentDetails.provider_wallet &&
              paymentDetails.payment_mode === "split_native";

            // Facilitator mode (Polygon EIP-3009, gas-free): the backend exposes
            // a `facilitator` URL in payment_details when POLYGON_FACILITATOR_URL
            // is configured. We sign off-chain and let the facilitator broadcast.
            // Only applies when the chain implements EIP-3009 (not SKALE) and we
            // are NOT in native-split mode (split + facilitator are exclusive on
            // the backend: facilitator recipient is the FeeSplitter contract).
            const isFacilitatorMode =
              !isSplitMode &&
              !!paymentDetails.facilitator &&
              !!EIP3009_DOMAINS[network];

            let paidResponse: {
              statusCode: number;
              body: Record<string, unknown>;
            };
            let paymentMeta: Record<string, unknown>;

            if (isSplitMode) {
              // ── Native split: 2 separate on-chain transactions ──────
              // Tx1: 95% -> provider_wallet
              // Tx2: 5%  -> recipient (platform wallet)
              const providerWallet = paymentDetails.provider_wallet as Address;
              const platformRecipient = paymentDetails.recipient as Address;

              const split = await sendSplitPayment(
                privateKey,
                network,
                providerWallet,
                platformRecipient,
                amount,
              );
              totalSpent += amount;

              // Retry with both payment proofs in dedicated headers
              paidResponse = (await this.helpers.httpRequest({
                method: method as "GET" | "POST",
                url: fullUrl,
                headers: {
                  "X-Agent-Wallet": account.address,
                  "X-Payment-TxHash-Provider": split.txHashProvider,
                  "X-Payment-TxHash-Platform": split.txHashPlatform,
                  "X-Payment-Chain": network,
                },
                ...(isPost ? { body: params, json: true } : { json: true }),
                returnFullResponse: true,
                ignoreHttpStatusErrors: true,
              })) as { statusCode: number; body: Record<string, unknown> };

              paymentMeta = {
                service: svc.name,
                amount,
                paymentMode: "split_native",
                providerWallet,
                platformRecipient,
                providerAmount: split.providerAmountUsdc,
                platformAmount: split.platformAmountUsdc,
                txHashProvider: split.txHashProvider,
                txHashPlatform: split.txHashPlatform,
                explorerProvider: split.explorerProvider,
                explorerPlatform: split.explorerPlatform,
                from: split.from,
                network,
                totalSpent,
                budgetRemaining: maxBudget - totalSpent,
              };
            } else if (isFacilitatorMode) {
              // ── Facilitator mode: EIP-3009 gas-free (Polygon) ────────
              // Sign TransferWithAuthorization off-chain, POST to the
              // facilitator's /settle endpoint (it broadcasts on-chain and
              // sponsors gas), then retry the API call with the returned
              // txHash as a standard X-Payment-TxHash proof. The recipient is
              // the FeeSplitter contract (handles the 95/5 split on-chain).
              const recipient = paymentDetails.recipient as Address;
              const facilitatorUrl = paymentDetails.facilitator as string;

              const fac = await payViaFacilitator(
                this.helpers.httpRequest,
                privateKey,
                network,
                facilitatorUrl,
                recipient,
                apiUrl,
                amount,
              );
              totalSpent += amount;

              // Retry with the facilitator-settled tx hash as payment proof
              paidResponse = (await this.helpers.httpRequest({
                method: method as "GET" | "POST",
                url: fullUrl,
                headers: {
                  "X-Agent-Wallet": account.address,
                  "X-Payment-TxHash": fac.txHash,
                  "X-Payment-Chain": network,
                },
                ...(isPost ? { body: params, json: true } : { json: true }),
                returnFullResponse: true,
                ignoreHttpStatusErrors: true,
              })) as { statusCode: number; body: Record<string, unknown> };

              paymentMeta = {
                service: svc.name,
                amount,
                paymentMode: "facilitator",
                facilitator: facilitatorUrl,
                recipient,
                txHash: fac.txHash,
                explorer: `${CHAINS[network].explorer}/tx/${fac.txHash}`,
                from: fac.from,
                network,
                totalSpent,
                budgetRemaining: maxBudget - totalSpent,
              };
            } else {
              // ── Legacy mode: single transaction to platform wallet ───
              // Used for internal services (no owner_address) and any
              // service where the backend does not send provider_wallet.
              const payment = await sendUsdcPayment(
                privateKey,
                network,
                paymentDetails.recipient as Address,
                amount,
              );
              totalSpent += amount;

              // Retry with payment proof
              paidResponse = (await this.helpers.httpRequest({
                method: method as "GET" | "POST",
                url: fullUrl,
                headers: {
                  "X-Agent-Wallet": account.address,
                  "X-Payment-TxHash": payment.txHash,
                  "X-Payment-Chain": network,
                },
                ...(isPost ? { body: params, json: true } : { json: true }),
                returnFullResponse: true,
                ignoreHttpStatusErrors: true,
              })) as { statusCode: number; body: Record<string, unknown> };

              paymentMeta = {
                service: svc.name,
                amount,
                paymentMode: "legacy",
                txHash: payment.txHash,
                explorer: payment.explorer,
                from: payment.from,
                network,
                totalSpent,
                budgetRemaining: maxBudget - totalSpent,
              };
            }

            // ── Consumer protection: detect not_charged / refunded ──────
            // The backend may return HTTP 200 (or an error status) with
            // _payment_status: "not_charged" | "refunded" in the body when the
            // call did not deliver a billed result. In both cases the agent was
            // NOT effectively charged for a successful response, so we must
            // refund the local budget counter and surface a clear error/warning
            // instead of treating it as a paid success. (Parity with MCP.)
            const txRefForFailure = isSplitMode
              ? `provider_tx: ${paymentMeta.txHashProvider as string}`
              : `tx: ${paymentMeta.txHash as string}`;
            const paymentFailure = detectPaymentFailure(paidResponse.body);
            if (paymentFailure) {
              // Roll back the local budget — the USDC was not spent (not_charged)
              // or was refunded on-chain (refunded).
              totalSpent = Math.max(0, totalSpent - amount);
              paymentMeta.totalSpent = totalSpent;
              paymentMeta.budgetRemaining = maxBudget - totalSpent;
              paymentMeta.paymentStatus = paymentFailure.status;
              if (paymentFailure.refundTxHash)
                paymentMeta.refundTxHash = paymentFailure.refundTxHash;
              if (paymentFailure.refundWallet)
                paymentMeta.refundWallet = paymentFailure.refundWallet;

              const detail =
                paymentFailure.status === "refunded"
                  ? `payment was refunded on-chain${paymentFailure.refundTxHash ? ` (refund tx: ${paymentFailure.refundTxHash})` : ""}`
                  : "the call was not charged (no paid result delivered)";
              const reasonSuffix = paymentFailure.reason
                ? ` Reason: ${paymentFailure.reason}.`
                : "";

              if (this.continueOnFail()) {
                // Surface as an explicit error item rather than a silent success.
                returnData.push({
                  json: {
                    error: `${svc.name}: ${detail}.${reasonSuffix}`,
                    operation,
                    _payment_status: paymentFailure.status,
                    _x402_payment: paymentMeta,
                    ...(paidResponse.body as Record<string, unknown>),
                  },
                  pairedItem: { item: i },
                });
                continue;
              }

              throw new NodeOperationError(
                this.getNode(),
                `${svc.name}: ${detail} — not a billed success (${txRefForFailure}).${reasonSuffix}`,
                { itemIndex: i },
              );
            }

            if (
              paidResponse.statusCode < 200 ||
              paidResponse.statusCode > 299
            ) {
              throw new NodeOperationError(
                this.getNode(),
                `${svc.name} returned ${paidResponse.statusCode} after payment (${txRefForFailure})`,
                { itemIndex: i },
              );
            }

            returnData.push({
              json: {
                ...(paidResponse.body as Record<string, unknown>),
                _x402_payment: paymentMeta,
              },
              pairedItem: { item: i },
            });
          } else if (
            initialResponse.statusCode >= 200 &&
            initialResponse.statusCode <= 299
          ) {
            // Free endpoint (or free-tier / credits-backed call with no 402).
            // Even without an on-chain payment, the backend can still return
            // _payment_status: "not_charged" (e.g. a required parameter was
            // missing). Surface that as an error instead of a silent success.
            const freeFailure = detectPaymentFailure(initialResponse.body);
            if (freeFailure) {
              const freeReason = freeFailure.reason
                ? ` Reason: ${freeFailure.reason}.`
                : "";
              if (this.continueOnFail()) {
                returnData.push({
                  json: {
                    error: `${svc.name}: call was not charged (no result delivered).${freeReason}`,
                    operation,
                    _payment_status: freeFailure.status,
                    ...(initialResponse.body as Record<string, unknown>),
                  },
                  pairedItem: { item: i },
                });
                continue;
              }
              throw new NodeOperationError(
                this.getNode(),
                `${svc.name}: call was not charged — no result delivered.${freeReason}`,
                { itemIndex: i },
              );
            }

            returnData.push({
              json: {
                ...(initialResponse.body as Record<string, unknown>),
                _x402_payment: null,
              },
              pairedItem: { item: i },
            });
          } else {
            throw new NodeOperationError(
              this.getNode(),
              `${svc.name} returned HTTP ${initialResponse.statusCode}: ${JSON.stringify(initialResponse.body)}`,
              { itemIndex: i },
            );
          }
        }

        // ────────────────────────────────────────────
        // LIST SERVICES
        // ────────────────────────────────────────────
        else if (operation === "listServices") {
          const categoryFilter = this.getNodeParameter(
            "categoryFilter",
            i,
            "",
          ) as string;

          const listRaw = (await this.helpers.httpRequest({
            method: "GET",
            url: `${baseUrl}/api/services`,
            json: true,
          })) as unknown;
          const services: Array<Record<string, unknown>> = Array.isArray(
            listRaw,
          )
            ? listRaw
            : (listRaw as any).data || (listRaw as any).services || [];

          let filtered = services;
          if (categoryFilter) {
            filtered = services.filter((s) =>
              ((s.tags as string[]) || []).some((t: string) =>
                t.toLowerCase().includes(categoryFilter.toLowerCase()),
              ),
            );
          }

          returnData.push({
            json: {
              success: true,
              count: filtered.length,
              totalOnMarketplace: services.length,
              filter: categoryFilter || "all",
              services: filtered.map((s) => ({
                name: s.name,
                description: s.description,
                price_usdc: s.price_usdc,
                url: s.url,
                tags: s.tags,
                verified_status: s.verified_status,
              })),
            },
            pairedItem: { item: i },
          });
        }

        // ────────────────────────────────────────────
        // GET BALANCE
        // ────────────────────────────────────────────
        else if (operation === "getBalance") {
          const balanceInfo = await getUsdcBalance(privateKey, network);

          returnData.push({
            json: {
              success: true,
              balance_usdc: balanceInfo.balance,
              address: balanceInfo.address,
              network: balanceInfo.network,
              budget: {
                max: maxBudget,
                spentThisExecution: totalSpent,
                remaining: maxBudget - totalSpent,
              },
            },
            pairedItem: { item: i },
          });
        }

        // ────────────────────────────────────────────
        // GET SERVICE INFO
        // ────────────────────────────────────────────
        else if (operation === "getServiceInfo") {
          const serviceRaw = this.getNodeParameter(
            "serviceInfoPath",
            i,
          ) as string;
          const svcMeta: ServiceMeta = JSON.parse(serviceRaw);

          const infoRaw = (await this.helpers.httpRequest({
            method: "GET",
            url: `${baseUrl}/api/services`,
            json: true,
          })) as unknown;
          const services: Array<Record<string, unknown>> = Array.isArray(
            infoRaw,
          )
            ? infoRaw
            : (infoRaw as any).data || (infoRaw as any).services || [];

          const found = services.find(
            (s) => s.url === svcMeta.url || s.name === svcMeta.name,
          );

          if (!found) {
            throw new NodeOperationError(
              this.getNode(),
              `Service "${svcMeta.name}" not found on the marketplace`,
              { itemIndex: i },
            );
          }

          returnData.push({
            json: {
              success: true,
              service: {
                name: found.name,
                description: found.description,
                price_usdc: found.price_usdc,
                url: found.url,
                method: found.method || svcMeta.method,
                tags: found.tags,
                category: found.category,
                verified_status: found.verified_status,
                verified_at: found.verified_at,
                owner_address: found.owner_address,
                created_at: found.created_at,
              },
            },
            pairedItem: { item: i },
          });
        }

        // ────────────────────────────────────────────
        // REGISTER SERVICE
        // ────────────────────────────────────────────
        // Registration uses legacy mode (1 USDC listing fee 100% to platform).
        // No split applies here: the fee is a platform listing fee, not a service call.
        else if (operation === "registerService") {
          const serviceName = this.getNodeParameter("serviceName", i) as string;
          const serviceUrl = this.getNodeParameter("serviceUrl", i) as string;
          const servicePrice = this.getNodeParameter(
            "servicePrice",
            i,
          ) as number;
          let ownerAddress = this.getNodeParameter(
            "ownerAddress",
            i,
            "",
          ) as string;
          const serviceDescription = this.getNodeParameter(
            "serviceDescription",
            i,
            "",
          ) as string;
          const tagsRaw = this.getNodeParameter("serviceTags", i, "") as string;

          // Derive owner address from credentials wallet if not provided
          if (!ownerAddress) {
            const account = privateKeyToAccount(privateKey as `0x${string}`);
            ownerAddress = account.address;
          }

          // Parse comma-separated tags
          const tags = tagsRaw
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
            .slice(0, 10);

          const registerBody = {
            name: serviceName,
            url: serviceUrl,
            price: servicePrice,
            ownerAddress,
            description: serviceDescription,
            tags,
          };

          const account = privateKeyToAccount(privateKey as `0x${string}`);

          // Step 1: Initial request -> expect 402
          const initialRes = (await this.helpers.httpRequest({
            method: "POST",
            url: `${baseUrl}/register`,
            headers: { "X-Agent-Wallet": account.address },
            body: registerBody,
            json: true,
            returnFullResponse: true,
            ignoreHttpStatusErrors: true,
          })) as { statusCode: number; body: Record<string, unknown> };

          if (initialRes.statusCode === 402) {
            const paymentDetails = initialRes.body?.payment_details as
              | { amount: number; recipient: string }
              | undefined;

            if (!paymentDetails) {
              throw new NodeOperationError(
                this.getNode(),
                "Registration: 402 response without payment_details",
                { itemIndex: i },
              );
            }

            const amount = paymentDetails.amount;

            // Budget guard
            if (totalSpent + amount > maxBudget) {
              throw new NodeOperationError(
                this.getNode(),
                `Budget exceeded: registration costs ${amount} USDC, but only ${(maxBudget - totalSpent).toFixed(4)} USDC remaining (max budget: ${maxBudget} USDC)`,
                { itemIndex: i },
              );
            }

            // Step 2: Send USDC payment (legacy — 100% listing fee to platform)
            const payment = await sendUsdcPayment(
              privateKey,
              network,
              paymentDetails.recipient as Address,
              amount,
            );
            totalSpent += amount;

            // Step 3: Retry with payment proof
            const paidRes = (await this.helpers.httpRequest({
              method: "POST",
              url: `${baseUrl}/register`,
              headers: {
                "X-Agent-Wallet": account.address,
                "X-Payment-TxHash": payment.txHash,
                "X-Payment-Chain": network,
              },
              body: registerBody,
              json: true,
              returnFullResponse: true,
              ignoreHttpStatusErrors: true,
            })) as { statusCode: number; body: Record<string, unknown> };

            if (paidRes.statusCode >= 200 && paidRes.statusCode <= 299) {
              returnData.push({
                json: {
                  ...(paidRes.body as Record<string, unknown>),
                  _x402_payment: {
                    service: serviceName,
                    amount,
                    paymentMode: "legacy",
                    txHash: payment.txHash,
                    explorer: payment.explorer,
                    from: payment.from,
                    network,
                    totalSpent,
                    budgetRemaining: maxBudget - totalSpent,
                  },
                },
                pairedItem: { item: i },
              });
            } else {
              throw new NodeOperationError(
                this.getNode(),
                `Registration failed after payment (HTTP ${paidRes.statusCode}): ${JSON.stringify(paidRes.body)}. Payment tx: ${payment.txHash}`,
                { itemIndex: i },
              );
            }
          } else if (initialRes.statusCode === 400) {
            // Validation error from backend
            throw new NodeOperationError(
              this.getNode(),
              `Validation error: ${JSON.stringify(initialRes.body)}`,
              { itemIndex: i },
            );
          } else if (
            initialRes.statusCode >= 200 &&
            initialRes.statusCode <= 299
          ) {
            // Registration without payment (unlikely but handle gracefully)
            returnData.push({
              json: initialRes.body as IDataObject,
              pairedItem: { item: i },
            });
          } else {
            throw new NodeOperationError(
              this.getNode(),
              `Registration error (HTTP ${initialRes.statusCode}): ${JSON.stringify(initialRes.body)}`,
              { itemIndex: i },
            );
          }
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: error instanceof Error ? error.message : String(error),
              operation,
            },
            pairedItem: { item: i },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
