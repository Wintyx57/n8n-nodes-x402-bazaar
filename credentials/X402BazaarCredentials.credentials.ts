import type {
	ICredentialType,
	ICredentialTestRequest,
	INodeProperties,
} from 'n8n-workflow';

export class X402BazaarCredentials implements ICredentialType {
	name = 'x402BazaarCredentials';
	displayName = 'x402 Bazaar';
	documentationUrl = 'https://x402bazaar.org/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'Private Key',
			name: 'privateKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: '0xabc123...',
			description:
				'Your wallet private key (hex, 0x-prefixed) for signing USDC payments on-chain. Never sent to x402 servers — only used locally to sign transactions.',
		},
		{
			displayName: 'Network',
			name: 'network',
			type: 'options',
			options: [
				{
					name: 'Base (Mainnet)',
					value: 'base',
					description: 'Base L2 — ~$0.001 gas per transaction',
				},
				{
					name: 'SKALE on Base (Ultra-low Gas)',
					value: 'skale',
					description: 'SKALE on Base — ultra-low gas fees (~$0.0007/tx via CREDITS)',
				},
			],
			default: 'base',
			description: 'Which blockchain network to use for USDC payments',
		},
		{
			displayName: 'API Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://x402-api.onrender.com',
			placeholder: 'https://x402-api.onrender.com',
			description: 'The x402 Bazaar API server URL. Change only if self-hosting.',
		},
		{
			displayName: 'Max Budget (USDC)',
			name: 'maxBudget',
			type: 'number',
			default: 1.0,
			typeOptions: { minValue: 0.01, maxValue: 100, numberPrecision: 2 },
			description:
				'Maximum USDC to spend per workflow execution. Acts as a safety cap to prevent runaway spending.',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			method: 'GET',
			url: '={{$credentials.baseUrl}}/health',
		},
	};
}
