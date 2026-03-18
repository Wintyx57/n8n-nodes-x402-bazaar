import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	createWalletClient,
	createPublicClient,
	http,
	parseUnits,
	type Address,
	type Hash,
} from 'viem';
import { base, polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

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
		rpcUrl: 'https://mainnet.base.org',
		usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		explorer: 'https://basescan.org',
		viemChain: base,
		decimals: 6,
		displayName: 'Base',
	},
	skale: {
		rpcUrl: 'https://skale-base.skalenodes.com/v1/base',
		usdcContract: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
		explorer: 'https://skale-base-explorer.skalenodes.com',
		viemChain: {
			id: 1187947933,
			name: 'SKALE on Base',
			nativeCurrency: { name: 'CREDITS', symbol: 'CREDITS', decimals: 18 },
			rpcUrls: {
				default: {
					http: ['https://skale-base.skalenodes.com/v1/base'],
				},
			},
		},
		decimals: 18,
		displayName: 'SKALE on Base',
	},
	polygon: {
		rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
		usdcContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as `0x${string}`,
		explorer: 'https://polygonscan.com',
		viemChain: polygon,
		decimals: 6,
		displayName: 'Polygon',
	},
};

const USDC_ABI = [
	{
		name: 'transfer',
		type: 'function',
		inputs: [
			{ name: 'to', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
		outputs: [{ type: 'bool' }],
		stateMutability: 'nonpayable',
	},
	{
		name: 'balanceOf',
		type: 'function',
		inputs: [{ name: 'account', type: 'address' }],
		outputs: [{ type: 'uint256' }],
		stateMutability: 'view',
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
		chain: chainCfg.viemChain as Parameters<typeof createWalletClient>[0]['chain'],
		transport: http(chainCfg.rpcUrl),
	});

	const publicClient = createPublicClient({
		chain: chainCfg.viemChain as Parameters<typeof createPublicClient>[0]['chain'],
		transport: http(chainCfg.rpcUrl),
	});

	// Check balance first
	const balance = await publicClient.readContract({
		address: chainCfg.usdcContract,
		abi: USDC_ABI,
		functionName: 'balanceOf',
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
		functionName: 'transfer',
		args: [recipient, amountRaw],
		chain: null,
	});

	// Wait for 1 confirmation
	await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });

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

	// Integer arithmetic using chain-specific decimals (6 for Base/Polygon, 18 for SKALE)
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
	const providerResult = await _sendUsdcRaw(privateKey, chainCfg, providerWallet, providerRaw);

	// Tx2: 5% to platform
	const platformResult = await _sendUsdcRaw(privateKey, chainCfg, platformRecipient, platformRaw);

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
		chain: chainCfg.viemChain as Parameters<typeof createPublicClient>[0]['chain'],
		transport: http(chainCfg.rpcUrl),
	});

	const balance = await publicClient.readContract({
		address: chainCfg.usdcContract,
		abi: USDC_ABI,
		functionName: 'balanceOf',
		args: [account.address],
	});

	return {
		balance: Number(balance) / (10 ** chainCfg.decimals),
		address: account.address,
		network: chainCfg.displayName,
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
	'/api/code', '/api/code-review', '/api/math', '/api/regex',
	'/api/contract-risk', '/api/email-parse', '/api/table-insights',
	'/api/domain-report', '/api/seo-audit', '/api/lead-score',
	'/api/crypto-intelligence',
]);

// ─── Node Class ─────────────────────────────────────────────────────────────

export class X402Bazaar implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'x402 Bazaar',
		name: 'x402Bazaar',
		icon: 'file:x402-bazaar.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Access 70+ APIs from the x402 Bazaar marketplace with automatic USDC payments on Base, SKALE or Polygon',
		defaults: {
			name: 'x402 Bazaar',
		},
		usableAsTool: true,
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'x402BazaarCredentials',
				required: true,
			},
		],
		properties: [
			// ── Operation selector ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Call API',
						value: 'callApi',
						description: 'Call any API on the marketplace with automatic x402 payment',
						action: 'Call an API on x402 Bazaar',
					},
					{
						name: 'List Services',
						value: 'listServices',
						description: 'Browse all available APIs on the marketplace',
						action: 'List available services',
					},
					{
						name: 'Get Balance',
						value: 'getBalance',
						description: 'Check your wallet USDC balance and budget status',
						action: 'Get wallet balance',
					},
					{
						name: 'Get Service Info',
						value: 'getServiceInfo',
						description: 'Get detailed information about a specific API service',
						action: 'Get service details',
					},
					{
						name: 'Register Service',
						value: 'registerService',
						description: 'Register your API on the x402 Bazaar marketplace (1 USDC)',
						action: 'Register a new service on the marketplace',
					},
				],
				default: 'callApi',
			},

			// ── Call API: Service dropdown ──
			{
				displayName: 'Service',
				name: 'servicePath',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getServices',
				},
				required: true,
				default: '',
				displayOptions: {
					show: { operation: ['callApi'] },
				},
				description: 'Select the API to call. This list is fetched live from the marketplace.',
			},

			// ── Call API: HTTP method override ──
			{
				displayName: 'HTTP Method',
				name: 'httpMethod',
				type: 'options',
				options: [
					{
						name: 'Auto-Detect',
						value: 'auto',
						description:
							'GET for most APIs, POST for code/math/intelligence endpoints',
					},
					{ name: 'GET', value: 'GET' },
					{ name: 'POST (JSON Body)', value: 'POST' },
				],
				default: 'auto',
				displayOptions: {
					show: { operation: ['callApi'] },
				},
				description: 'HTTP method override. Auto-detect is correct for most APIs.',
			},

			// ── Call API: Parameters ──
			{
				displayName: 'Parameters',
				name: 'parameters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				displayOptions: {
					show: { operation: ['callApi'] },
				},
				default: {},
				placeholder: 'Add Parameter',
				description: 'Query parameters (GET) or body fields (POST) to send with the API call',
				options: [
					{
						name: 'entries',
						displayName: 'Parameter',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
								placeholder: 'q',
								description: 'Parameter name (e.g. "q", "city", "coin")',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								placeholder: 'artificial intelligence',
								description: 'Parameter value',
							},
						],
					},
				],
			},

			// ── List Services: Category filter ──
			{
				displayName: 'Category',
				name: 'categoryFilter',
				type: 'options',
				displayOptions: {
					show: { operation: ['listServices'] },
				},
				options: [
					{ name: 'All Categories', value: '' },
					{ name: 'AI', value: 'ai' },
					{ name: 'Data', value: 'data' },
					{ name: 'Intelligence', value: 'intelligence' },
					{ name: 'Misc', value: 'misc' },
					{ name: 'Text', value: 'text' },
					{ name: 'Tools', value: 'tools' },
					{ name: 'Validation', value: 'validation' },
					{ name: 'Web', value: 'web' },
				],
				default: '',
				description: 'Filter services by category',
			},

			// ── Get Service Info: Service dropdown ──
			{
				displayName: 'Service',
				name: 'serviceInfoPath',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getServices',
				},
				required: true,
				default: '',
				displayOptions: {
					show: { operation: ['getServiceInfo'] },
				},
				description: 'Select the service to get information about',
			},

			// ── Register Service: Fields ──
			{
				displayName: 'Service Name',
				name: 'serviceName',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { operation: ['registerService'] },
				},
				placeholder: 'My Weather API',
				description: 'Name of the API service to register on the marketplace',
			},
			{
				displayName: 'Service URL',
				name: 'serviceUrl',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { operation: ['registerService'] },
				},
				placeholder: 'https://api.example.com/weather',
				description: 'Full URL of your API endpoint (must be HTTP or HTTPS)',
			},
			{
				displayName: 'Price (USDC)',
				name: 'servicePrice',
				type: 'number',
				required: true,
				default: 0.01,
				displayOptions: {
					show: { operation: ['registerService'] },
				},
				typeOptions: {
					minValue: 0,
					maxValue: 1000,
					numberPrecision: 4,
				},
				description: 'Price per API call in USDC (0-1000)',
			},
			{
				displayName: 'Description',
				name: 'serviceDescription',
				type: 'string',
				default: '',
				displayOptions: {
					show: { operation: ['registerService'] },
				},
				placeholder: 'Returns current weather data for any city worldwide',
				description: 'Description of what your API does (max 1000 characters)',
			},
			{
				displayName: 'Owner Address',
				name: 'ownerAddress',
				type: 'string',
				default: '',
				displayOptions: {
					show: { operation: ['registerService'] },
				},
				placeholder: '0x...',
				description: 'Ethereum wallet address that owns this service. Leave empty to use your wallet from credentials.',
			},
			{
				displayName: 'Tags',
				name: 'serviceTags',
				type: 'string',
				default: '',
				displayOptions: {
					show: { operation: ['registerService'] },
				},
				placeholder: 'weather, data, geo',
				description: 'Comma-separated tags for your service (max 10 tags)',
			},
		],
	};

	// ── Dynamic dropdown: load services from marketplace ──

	methods = {
		loadOptions: {
			async getServices(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('x402BazaarCredentials');
				const baseUrl = (
					(credentials.baseUrl as string) || 'https://x402-api.onrender.com'
				).replace(/\/$/, '');

				const servicesRaw = (await this.helpers.httpRequest({
					method: 'GET',
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
					: ((servicesRaw as any).data || (servicesRaw as any).services || []);

				const options: INodePropertyOptions[] = [];

				for (const svc of services) {
					// Extract endpoint path for native APIs
					const nativeMatch = (svc.url || '').match(/\/api\/[\w-]+$/);
					const path = nativeMatch ? nativeMatch[0] : svc.url || '';
					const isNative = (svc.tags || []).includes('x402-native');

					const price = svc.price_usdc ?? 0;
					const verified = svc.verified_status === 'mainnet_verified' ? ' [Verified]' : '';
					const tag = isNative ? 'Native' : 'External';

					// Detect HTTP method
					const method = svc.method || (POST_ENDPOINTS.has(path) ? 'POST' : 'GET');

					const meta: ServiceMeta = { path, name: svc.name, price, url: svc.url, method, isNative };

					options.push({
						name: `${svc.name} — ${price} USDC (${tag})${verified}`,
						value: JSON.stringify(meta),
						description: svc.description || '',
					});
				}

				options.sort((a, b) => (a.name as string).localeCompare(b.name as string));
				return options;
			},
		},
	};

	// ── Execute ──

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		const credentials = await this.getCredentials('x402BazaarCredentials');
		const baseUrl = (
			(credentials.baseUrl as string) || 'https://x402-api.onrender.com'
		).replace(/\/$/, '');
		const privateKey = credentials.privateKey as string;
		const network = (credentials.network as string) || 'base';
		const maxBudget = (credentials.maxBudget as number) || 1.0;

		// Budget tracking across all items
		let totalSpent = 0;

		for (let i = 0; i < items.length; i++) {
			try {
				// ────────────────────────────────────────────
				// CALL API
				// ────────────────────────────────────────────
				if (operation === 'callApi') {
					const serviceRaw = this.getNodeParameter('servicePath', i) as string;
					const svc: ServiceMeta = JSON.parse(serviceRaw);
					const httpMethodOverride = this.getNodeParameter('httpMethod', i) as string;
					const paramEntries = this.getNodeParameter(
						'parameters.entries',
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
					if (httpMethodOverride === 'auto') {
						method = POST_ENDPOINTS.has(svc.path) ? 'POST' : (svc.method || 'GET');
					} else {
						method = httpMethodOverride;
					}

					// Build request URL / body
					const isPost = method === 'POST';
					const queryString = !isPost
						? new URLSearchParams(params).toString()
						: '';
					const fullUrl = queryString ? `${apiUrl}?${queryString}` : apiUrl;

					// Derive wallet address
					const account = privateKeyToAccount(privateKey as `0x${string}`);

					// Step 1: Initial request (no payment header)
					const initialResponse = await this.helpers.httpRequest({
						method: method as 'GET' | 'POST',
						url: fullUrl,
						headers: { 'X-Agent-Wallet': account.address },
						...(isPost ? { body: params, json: true } : { json: true }),
						returnFullResponse: true,
						ignoreHttpStatusErrors: true,
					}) as { statusCode: number; body: Record<string, unknown> };

					// Step 2: Handle 402 — pay and retry
					if (initialResponse.statusCode === 402) {
						// payment_details may include split fields when the service has an
						// external owner_address (payment_mode: "split_native").
						const paymentDetails = (initialResponse.body as Record<string, unknown>)
							?.payment_details as
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

						// ── Detect split mode ──────────────────────────────────
						// The backend signals split mode via payment_mode: "split_native"
						// and provider_wallet. Both must be present to enable split.
						// Services without an owner_address use legacy mode (100% to platform).
						const isSplitMode =
							!!paymentDetails.provider_wallet &&
							paymentDetails.payment_mode === 'split_native';

						let paidResponse: { statusCode: number; body: Record<string, unknown> };
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
								method: method as 'GET' | 'POST',
								url: fullUrl,
								headers: {
									'X-Agent-Wallet': account.address,
									'X-Payment-TxHash-Provider': split.txHashProvider,
									'X-Payment-TxHash-Platform': split.txHashPlatform,
									'X-Payment-Chain': network,
								},
								...(isPost ? { body: params, json: true } : { json: true }),
								returnFullResponse: true,
								ignoreHttpStatusErrors: true,
							})) as { statusCode: number; body: Record<string, unknown> };

							paymentMeta = {
								service: svc.name,
								amount,
								paymentMode: 'split_native',
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
								method: method as 'GET' | 'POST',
								url: fullUrl,
								headers: {
									'X-Agent-Wallet': account.address,
									'X-Payment-TxHash': payment.txHash,
									'X-Payment-Chain': network,
								},
								...(isPost ? { body: params, json: true } : { json: true }),
								returnFullResponse: true,
								ignoreHttpStatusErrors: true,
							})) as { statusCode: number; body: Record<string, unknown> };

							paymentMeta = {
								service: svc.name,
								amount,
								paymentMode: 'legacy',
								txHash: payment.txHash,
								explorer: payment.explorer,
								from: payment.from,
								network,
								totalSpent,
								budgetRemaining: maxBudget - totalSpent,
							};
						}

						if (paidResponse.statusCode < 200 || paidResponse.statusCode > 299) {
							const txRef = isSplitMode
								? `provider_tx: ${paymentMeta.txHashProvider as string}`
								: `tx: ${paymentMeta.txHash as string}`;
							throw new NodeOperationError(
								this.getNode(),
								`${svc.name} returned ${paidResponse.statusCode} after payment (${txRef})`,
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
					} else if (initialResponse.statusCode >= 200 && initialResponse.statusCode <= 299) {
						// Free endpoint
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
				else if (operation === 'listServices') {
					const categoryFilter = this.getNodeParameter('categoryFilter', i, '') as string;

					const listRaw = (await this.helpers.httpRequest({
						method: 'GET',
						url: `${baseUrl}/api/services`,
						json: true,
					})) as unknown;
					const services: Array<Record<string, unknown>> = Array.isArray(listRaw)
						? listRaw
						: ((listRaw as any).data || (listRaw as any).services || []);

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
							filter: categoryFilter || 'all',
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
				else if (operation === 'getBalance') {
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
				else if (operation === 'getServiceInfo') {
					const serviceRaw = this.getNodeParameter('serviceInfoPath', i) as string;
					const svcMeta: ServiceMeta = JSON.parse(serviceRaw);

					const infoRaw = (await this.helpers.httpRequest({
						method: 'GET',
						url: `${baseUrl}/api/services`,
						json: true,
					})) as unknown;
					const services: Array<Record<string, unknown>> = Array.isArray(infoRaw)
						? infoRaw
						: ((infoRaw as any).data || (infoRaw as any).services || []);

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
				else if (operation === 'registerService') {
					const serviceName = this.getNodeParameter('serviceName', i) as string;
					const serviceUrl = this.getNodeParameter('serviceUrl', i) as string;
					const servicePrice = this.getNodeParameter('servicePrice', i) as number;
					let ownerAddress = this.getNodeParameter('ownerAddress', i, '') as string;
					const serviceDescription = this.getNodeParameter('serviceDescription', i, '') as string;
					const tagsRaw = this.getNodeParameter('serviceTags', i, '') as string;

					// Derive owner address from credentials wallet if not provided
					if (!ownerAddress) {
						const account = privateKeyToAccount(privateKey as `0x${string}`);
						ownerAddress = account.address;
					}

					// Parse comma-separated tags
					const tags = tagsRaw
						.split(',')
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
						method: 'POST',
						url: `${baseUrl}/register`,
						headers: { 'X-Agent-Wallet': account.address },
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
								'Registration: 402 response without payment_details',
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
							method: 'POST',
							url: `${baseUrl}/register`,
							headers: {
								'X-Agent-Wallet': account.address,
								'X-Payment-TxHash': payment.txHash,
								'X-Payment-Chain': network,
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
										paymentMode: 'legacy',
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
					} else if (initialRes.statusCode >= 200 && initialRes.statusCode <= 299) {
						// Registration without payment (unlikely but handle gracefully)
						returnData.push({
							json: initialRes.body as Record<string, unknown>,
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
