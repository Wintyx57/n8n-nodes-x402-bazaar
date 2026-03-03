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
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ─── Chain Configuration ────────────────────────────────────────────────────

interface ChainConfig {
	rpcUrl: string;
	usdcContract: Address;
	explorer: string;
	viemChain: object;
}

const CHAINS: Record<string, ChainConfig> = {
	base: {
		rpcUrl: 'https://mainnet.base.org',
		usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		explorer: 'https://basescan.org',
		viemChain: base,
	},
	skale: {
		rpcUrl: 'https://mainnet.skalenodes.com/v1/elated-tan-skat',
		usdcContract: '0x5F795bb52dAc3085f578f4877D450e2929D2F13d',
		explorer: 'https://elated-tan-skat.explorer.mainnet.skalenodes.com',
		viemChain: {
			id: 2046399126,
			name: 'SKALE Europa Hub',
			nativeCurrency: { name: 'sFUEL', symbol: 'sFUEL', decimals: 18 },
			rpcUrls: {
				default: {
					http: ['https://mainnet.skalenodes.com/v1/elated-tan-skat'],
				},
			},
		},
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

async function sendUsdcPayment(
	privateKey: string,
	network: string,
	recipient: Address,
	amountUsdc: number,
): Promise<{ txHash: Hash; explorer: string; from: string }> {
	const chainCfg = CHAINS[network] || CHAINS.base;
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

	const amount = parseUnits(amountUsdc.toString(), 6);

	// Check balance first
	const balance = await publicClient.readContract({
		address: chainCfg.usdcContract,
		abi: USDC_ABI,
		functionName: 'balanceOf',
		args: [account.address],
	});

	if (balance < amount) {
		throw new Error(
			`Insufficient USDC balance: ${(Number(balance) / 1e6).toFixed(4)} available, ${amountUsdc} required on ${network}`,
		);
	}

	// Send USDC transfer
	const txHash = await walletClient.writeContract({
		address: chainCfg.usdcContract,
		abi: USDC_ABI,
		functionName: 'transfer',
		args: [recipient, amount],
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
		balance: Number(balance) / 1e6,
		address: account.address,
		network: chainCfg === CHAINS.skale ? 'SKALE Europa' : 'Base',
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
			'Access 70+ APIs from the x402 Bazaar marketplace with automatic USDC payments on Base or SKALE',
		defaults: {
			name: 'x402 Bazaar',
		},
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

				const services = (await this.helpers.httpRequest({
					method: 'GET',
					url: `${baseUrl}/api/services`,
					json: true,
				})) as Array<{
					name: string;
					url: string;
					price_usdc: number;
					tags: string[];
					method?: string;
					verified_status?: string;
					description?: string;
				}>;

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

					// Step 1: Initial request
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
						const paymentDetails = (initialResponse.body as Record<string, unknown>)
							?.payment_details as
							| { amount: number; recipient: string }
							| undefined;

						if (!paymentDetails) {
							throw new NodeOperationError(
								this.getNode(),
								`${svc.name}: 402 response without payment_details`,
								{ itemIndex: i },
							);
						}

						const amount = paymentDetails.amount;

						// Budget guard
						if (totalSpent + amount > maxBudget) {
							throw new NodeOperationError(
								this.getNode(),
								`Budget exceeded: ${svc.name} costs ${amount} USDC, but only ${(maxBudget - totalSpent).toFixed(4)} USDC remaining (max budget: ${maxBudget} USDC)`,
								{ itemIndex: i },
							);
						}

						// Send USDC on-chain
						const payment = await sendUsdcPayment(
							privateKey,
							network,
							paymentDetails.recipient as Address,
							amount,
						);
						totalSpent += amount;

						// Retry with payment proof
						const paidResponse = await this.helpers.httpRequest({
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
						}) as { statusCode: number; body: Record<string, unknown> };

						if (paidResponse.statusCode !== 200) {
							throw new NodeOperationError(
								this.getNode(),
								`${svc.name} returned ${paidResponse.statusCode} after payment (tx: ${payment.txHash})`,
								{ itemIndex: i },
							);
						}

						returnData.push({
							json: {
								...(paidResponse.body as Record<string, unknown>),
								_x402_payment: {
									service: svc.name,
									amount,
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
					} else if (initialResponse.statusCode === 200) {
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

					const services = (await this.helpers.httpRequest({
						method: 'GET',
						url: `${baseUrl}/api/services`,
						json: true,
					})) as Array<Record<string, unknown>>;

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

					const services = (await this.helpers.httpRequest({
						method: 'GET',
						url: `${baseUrl}/api/services`,
						json: true,
					})) as Array<Record<string, unknown>>;

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
