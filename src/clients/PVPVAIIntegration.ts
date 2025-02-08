import { ethers } from "ethers";
import { supabase } from "../index.ts";
import type {
  ExtendedAgentRuntime,
  Character as ExtendedCharacter,
} from "../types/index.ts";
import { AgentClient } from "./AgentClient.ts";
export const HARDCODED_ROOM_ID = Number(process.env.ROOM_ID) || 290;

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
  private port: number;
  private wallet: ethers.Wallet;

  constructor(
    runtime: ExtendedAgentRuntime,
    config: ClientInitializationConfig
  ) {
    this.runtime = runtime;
    const char = runtime.character as unknown as ExtendedCharacter;

    const walletAddress =
      char.settings?.pvpvai?.ethWalletAddress || config.walletAddress;
    if (!walletAddress) {
      throw new Error(
        "No ethWalletAddress found in character settings or config"
      );
    }

    const agentId = char.settings?.pvpvai?.agentId || config.agentId;
    if (!agentId) {
      throw new Error("No agentId found in character settings or config");
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
      agentConfig.eth_wallet_address.toLowerCase() !==
        wallet.address.toLowerCase() &&
      agentConfig.room_agents.find(
        (ra) => ra.wallet_address.toLowerCase() === wallet.address.toLowerCase()
      ) === undefined
    ) {
      throw new Error(
        `Client side private key did not resolve to the same address as we have registered 
        with the server for agent ${this.agentId} (also checked AGENT_${
          this.agentId
        }_PRIVATE_KEY). 
        Expected ${
          agentConfig.eth_wallet_address
        } or ${agentConfig.room_agents.map((ra) => ra.wallet_address)}, got ${
          wallet.address
        }`
      );
    }

    this.client = new AgentClient(
      this.runtime,
      this.pvpvaiServerUrl,
      wallet,
      this.agentId
    );

    // Connect to room - backend will handle round assignment
    await this.client.initializeRoomContext(this.roomId);
  }

  private async getAgentConfig(agentId?: number) {
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("*, room_agents(wallet_address)")
      .eq("id", agentId)
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
    this.client.stop();
  }
}

// Factory function to create PVPVAIIntegration
export const createPVPVAIClient = (
  runtime: ExtendedAgentRuntime,
  config: ClientInitializationConfig
): PVPVAIIntegration => {
  return new PVPVAIIntegration(runtime, config);
};
