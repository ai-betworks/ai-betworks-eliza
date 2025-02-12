import { ethers } from 'ethers';
import { ContractEventListener } from '../ContractEventListener.ts';
import { supabase } from '../index.ts';
import { roomAbi } from '../types/contract.types.ts';
import type { ExtendedAgentRuntime, Character as ExtendedCharacter } from '../types/index.ts';
import { AgentClient } from './AgentClient.ts';

export const HARDCODED_ROOM_ID = 17;

export interface ClientInitializationConfig {
  pvpvaiUrl: string;
  walletAddress: string;
  creatorId: number;
  agentId: number;
  privateKey: string;
  roomId?: number;
}

export class PVPVAIIntegration {
  private client: AgentClient;
  private runtime: ExtendedAgentRuntime;
  private agentId: number;
  private pvpvaiServerUrl: string;
  private roomId: number = HARDCODED_ROOM_ID; //Temporarily hardcoded
  private eventListener: ContractEventListener | null = null;

  constructor(runtime: ExtendedAgentRuntime, config: ClientInitializationConfig) {
    this.runtime = runtime;
    const char = runtime.character as unknown as ExtendedCharacter;

    const walletAddress = char.settings?.pvpvai?.ethWalletAddress || config.walletAddress;
    if (!walletAddress) {
      throw new Error('No ethWalletAddress found in character settings or config');
    }

    const agentId = char.settings?.pvpvai?.agentId || config.agentId;
    if (!agentId) {
      throw new Error('No agentId found in character settings or config');
    }
    this.agentId = agentId;

    this.pvpvaiServerUrl = char.settings?.pvpvai?.pvpvaiServerUrl || config.pvpvaiUrl;
  }

  public async initialize(): Promise<void> {
    const agentConfig = await this.getAgentConfig(this.agentId);

    //TODO I think we  load the wallet somewhere else too, code smell
    const privateKeyEnv = `AGENT_${this.agentId}_PRIVATE_KEY`;
    const privateKey = process.env[privateKeyEnv];
    if (!privateKey) {
      throw new Error(`${privateKeyEnv} not found in environment variables`);
    }
    const wallet = new ethers.Wallet(privateKey);

    if (
      agentConfig.eth_wallet_address.toLowerCase() !== wallet.address.toLowerCase() &&
      agentConfig.room_agents.find(ra => ra.wallet_address.toLowerCase() === wallet.address.toLowerCase()) === undefined
    ) {
      throw new Error(
        `Client side private key did not resolve to the same address as we have registered 
        with the server for agent ${this.agentId} (also checked AGENT_${this.agentId}_PRIVATE_KEY). 
        Expected ${agentConfig.eth_wallet_address} or ${agentConfig.room_agents.map(ra => ra.wallet_address)}, got ${
          wallet.address
        }`
      );
    }

    this.client = new AgentClient(this.runtime, this.pvpvaiServerUrl, wallet, this.agentId);
    await this.client.initializeRoomContext(this.roomId);

    // Initialize contract event listener
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('contract_address, chain_id')
      .eq('id', this.roomId)
      .single();

    if (roomError) {
      throw roomError;
    }

    if (room.contract_address) {
      // You'll need to provide the ABI and RPC URL based on your setup
      const rpcUrl = this.getRpcUrlForChain(room.chain_id);

      this.eventListener = new ContractEventListener(room.contract_address, roomAbi, rpcUrl, this.client);

      await this.eventListener.startListening();
    }
  }

  private async getAgentConfig(agentId?: number) {
    const { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('*, room_agents(wallet_address)')
      .eq('id', agentId)
      .single();

    if (agentError) {
      throw agentError;
    }
    return agent;
  }

  public getClient() {
    return this.client;
  }

  public close(): void {
    if (this.eventListener) {
      // this.eventListener.stopListening();
    }
    this.client.stop();
  }

  private getRpcUrlForChain(chainId: number): string {
    // Add logic to return appropriate RPC URL based on chain ID
    // Example:

    switch (chainId) {
      case 1:
        return process.env.ETH_MAINNET_RPC_URL || '';
      case 5:
        return process.env.ETH_GOERLI_RPC_URL || '';
      case 11155111:
        return process.env.ETH_SEPOLIA_RPC_URL || '';
      case 8453:
        return process.env.ETH_BASE_MAINNET_RPC_URL || '';
      case 84532:
        return process.env.ETH_BASE_SEPOLIA_RPC_URL || '';
      case 137:
        return process.env.ETH_POLYGON_MAINNET_RPC_URL || '';
      case 80001:
        return process.env.ETH_POLYGON_MUMBAI_RPC_URL || '';
      case 42161:
        return process.env.ETH_ARBITRUM_MAINNET_RPC_URL || '';
      case 421611:
        return process.env.ETH_ARBITRUM_SEPOLIA_RPC_URL || '';
      case 10:
        return process.env.ETH_OPTIMISM_MAINNET_RPC_URL || '';
      case 420:
        return process.env.ETH_OPTIMISM_SEPOLIA_RPC_URL || '';
      case 1329:
        return process.env.ETH_ZKSYNC_MAINNET_RPC_URL || '';
      case 1328:
        return process.env.ETH_ZKSYNC_SEPOLIA_RPC_URL || '';

      default:
        throw new Error(`No RPC URL configured for chain ID ${chainId}`);
    }
  }
}

// Factory function to create PVPVAIIntegration
export const createPVPVAIClient = (
  runtime: ExtendedAgentRuntime,
  config: ClientInitializationConfig
): PVPVAIIntegration => {
  return new PVPVAIIntegration(runtime, config);
};
